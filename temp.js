
const { owner, repo } = context.repo;
const LABEL = process.env.LABEL;
const EXEMPTION_REQUEST_LABEL = process.env.EXEMPTION_REQUEST_LABEL;
const hours = process.env.CLOSE_AFTER_HOURS;
const APPROVED_MARKER = '<!-- screencast-approved -->';

// Video detection helper
const ASSET_RE = /https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/gi;
const LINK_RE = /https:\/\/[^\s)"'<>]+\.(mp4|mov|webm|mkv|avi|flv|m4v)\b|https:\/\/[^\s)"'<>]*?(?:screencast|screen[-_]?recording|demo|preview)[^\s)"'<>]*?\.gif\b|https:\/\/(www\.)?(youtube\.com|youtu\.be|loom\.com|vimeo\.com|streamable\.com|asciinema\.org|cleanshot\.cloud|drive\.google\.com\/(?:file\/d|open))\/\S+/i;

const hasVideoText = body => {
    body = body ?? '';

    if (LINK_RE.test(body)) return true;

    for (const m of body.matchAll(ASSET_RE)) {
        const before = body.slice(Math.max(0, m.index - 500), m.index);

        if (/!\[[^\]]*\]\(\s*$/.test(before)) continue; // markdown image
        if (/<img\b[^>]*$/i.test(before)) continue;     // html image

        return true;
    }

    return false;
};

const isPrEvent = context.eventName === 'pull_request_target';
const issueNumber = isPrEvent
    ? context.payload.pull_request.number
    : context.payload.issue.number;

// Fetch live PR details to avoid cached or stale data
const { data: currentPr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: issueNumber,
});

if (currentPr.state === 'closed') {
    core.info(`#${issueNumber}: PR is closed, skipping`);
    return;
}

const author = currentPr.user.login;
const labelsOnPr = (currentPr.labels ?? []).map(l => l.name);
const hasScreencastLabel = labelsOnPr.includes(LABEL);

// Contributor ticked "- [x] Screencast is not required for this PR."
// Checked on the live PR body so it also works for issue_comment events.
const selfScreenCastchecklist = body =>
    /^- \[[xX]\] Screencast is not required for this PR\.$/m.test(
        (body ?? '').replace(/\r/g, '')
    );

const exemptionRequested = selfScreenCastchecklist(currentPr.body);

// A maintainer manually adding needs-screencast always wins over the checklist.
const maintainerAddedLabel =
    isPrEvent &&
    context.payload.action === 'labeled' &&
    context.payload.label?.name === LABEL;

if (exemptionRequested && !maintainerAddedLabel) {
    // Label for reviewers to see, and drop needs-screencast so the hourly job never closes the PR.
    if (!labelsOnPr.includes(EXEMPTION_REQUEST_LABEL)) {
        await github.rest.issues.addLabels({
            owner,
            repo,
            issue_number: issueNumber,
            labels: [EXEMPTION_REQUEST_LABEL],
        });
    }

    if (hasScreencastLabel) {
        await github.rest.issues.removeLabel({
            owner,
            repo,
            issue_number: issueNumber,
            name: LABEL,
        });
    }

    core.info(`#${issueNumber}: screencast exemption requested via checklist, skipping`);
    return;
}

// Checkbox was unticked again: remove the stale exemption label.
if (!exemptionRequested && labelsOnPr.includes(EXEMPTION_REQUEST_LABEL)) {
    await github.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: issueNumber,
        name: EXEMPTION_REQUEST_LABEL,
    });

    if (!videoPresent) {
        await github.rest.issues.addLabels({
            owner,
            repo,
            issue_number: issueNumber,
            labels: [LABEL],
        });

        core.info(`#${issueNumber}: exemption withdrawn, restored ${LABEL} label`);
    }
}

// Fetch all comments on the PR to check for video links
const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
});

const hasVideoInDescription = hasVideoText(currentPr.body);
const hasVideoInComments = comments.some(c =>
    !c.user?.type?.includes('Bot') &&
    !c.user?.login?.endsWith('[bot]') &&
    hasVideoText(c.body)
);

const videoPresent = hasVideoInDescription || hasVideoInComments;

// 1. If PR currently has the needs-screencast label AND a video is now present:
// Remove the label immediately and confirm!
if (hasScreencastLabel && videoPresent) {
    await github.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: issueNumber,
        name: LABEL,
    });

    const alreadyConfirmed = comments.some(
        c => c.body && c.body.includes(APPROVED_MARKER)
    );

    if (!alreadyConfirmed) {
        await github.rest.issues.createComment({
            owner,
            repo,
            issue_number: issueNumber,
            body: [
                APPROVED_MARKER,
                `Thank you @${author} for adding a screencast! The \`${LABEL}\` label has been removed and this PR is ready for maintainer review.`,
            ].join('\n'),
        });
    }

    core.info(`#${issueNumber}: video detected, removed ${LABEL} label`);
    return;
}

// 2. If PR does NOT have needs-screencast label, check if we need to request one:
if (!hasScreencastLabel && isPrEvent) {
    const action = context.payload.action;

    // Case A: Maintainer manually added the needs-screencast label
    if (action === 'labeled') {
        if (context.payload.label?.name !== LABEL) return;

        if (videoPresent) {
            // Video already present, undo the label immediately
            await github.rest.issues.removeLabel({
                owner,
                repo,
                issue_number: issueNumber,
                name: LABEL,
            });

            return;
        }

        const alreadyRequested = comments.some(
            c => c.body && c.body.includes('please add a **short screencast video**')
        );

        if (!alreadyRequested) {
            await github.rest.issues.createComment({
                owner,
                repo,
                issue_number: issueNumber,
                body: [
                    `Hi @${author}, thanks for your contribution!`,
                    ``,
                    `Before we can review this PR, please add a **short screencast video** showing the change working (before/after where relevant).`,
                    ``,
                    `If no video is added within **${hours} hours**, this PR will be closed automatically. You are welcome to reopen it or submit a new PR once you have the screencast.`,
                ].join('\n'),
            });

            core.info(`#${issueNumber}: screencast request comment posted after label added`);
        }

        return;
    }

    // Case B: PR opened, reopened, or marked ready for review
    if (['opened', 'reopened', 'ready_for_review'].includes(action)) {
        if (currentPr.draft) {
            core.info(`#${issueNumber}: draft PR, screencast will be requested when marked ready for review`);
            return;
        }

        if (labelsOnPr.includes('pr-limit-reached')) {
            core.info(`#${issueNumber}: pr-limit-reached, skipping screencast request`);
            return;
        }

        if (videoPresent) {
            core.info(`#${issueNumber}: description or comments already contain a video, no screencast request needed`);
            return;
        }

        const events = await github.paginate(github.rest.issues.listEventsForTimeline, {
            owner,
            repo,
            issue_number: issueNumber,
            per_page: 100,
        });

        const hadScreencastLabel = events.some(
            e => e.event === 'labeled' && e.label?.name === LABEL
        );

        if (hadScreencastLabel) {
            core.info(`#${issueNumber}: screencast was already requested on this PR before, leaving it to reviewers`);
            return;
        }

        await github.rest.issues.createComment({
            owner,
            repo,
            issue_number: issueNumber,
            body: [
                `Hi @${author}, thanks for your contribution!`,
                ``,
                `Before we can review this PR, please add a **short screencast video** showing the change working (before/after where relevant).`,
                ``,
                `If no video is added within **${hours} hours**, this PR will be closed automatically. You are welcome to reopen it or submit a new PR once you have the screencast.`,
            ].join('\n'),
        });

        await github.rest.issues.addLabels({
            owner,
            repo,
            issue_number: issueNumber,
            labels: [LABEL],
        });

        core.info(`#${issueNumber}: screencast requested and label added`);
    }
}
