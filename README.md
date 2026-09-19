# Randy-The-Otter
Randy The Otter is your personal (not boring) job hunt assistant!

## Dev
After reloading the unpacked extension in `chrome://extensions`, **refresh any open LinkedIn tabs**. Otherwise the old content script keeps running orphaned (`chrome-extension://invalid/...` request errors) until the tab reloads.

## Settings
Click Randy's toolbar icon to open the settings page. Preferences are stored as one versioned JSON object in `chrome.storage.local` and are sent with job-summary requests. They influence match-score explanations without hiding jobs by default.

The settings include opportunity type, job titles, preset and custom locations, remote work, pay range, and employer sponsorship preference. Sponsorship describes whether the employer supports sponsorship; personal immigration status is not stored.
