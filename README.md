# Randy-The-Otter

Randy The Otter is your personal (not boring) job hunt assistant!

## Dev

After reloading the unpacked extension in `chrome://extensions`, **refresh any open LinkedIn tabs**. Otherwise the old content script keeps running orphaned (`chrome-extension://invalid/...` request errors) until the tab reloads.

## Settings

Click Randy's toolbar icon to open the settings page. Preferences are stored as one versioned JSON object in `chrome.storage.local` and are sent with job-summary requests. They influence match-score explanations without hiding jobs by default.

The settings include opportunity type, job titles, preset and custom locations, remote work, pay range, and employer sponsorship preference. Sponsorship describes whether the employer supports sponsorship; personal immigration status is not stored.

## Public site and extension download

The public download site is sourced from `site/`. Build it locally with:

```bash
npm install
npm run build
```

The build creates `public/index.html` and generates `public/downloads/randy-the-otter-extension.zip`. The ZIP contains only the `extenstion/` directory contents, with `manifest.json` at its root; backend code, secrets, virtual environments, and caches are excluded.

For Vercel, import this repository, keep the build command as `npm run build`, and set the output directory to `public`. The deployed download will be available at `/downloads/randy-the-otter-extension.zip`.

To install the downloaded extension locally, extract the ZIP, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the extracted folder. Refresh open job-board tabs after reloading the extension.
