# SCM SERVICE PORTAL

Forms list (MS Forms links) with per-user access, plus a complaint workflow.
No packages to install. Needs Node.js 18 or newer (https://nodejs.org, LTS version).

## Run
1. Open `config.js` in Notepad and set `adminUsername` / `adminPassword` (this is the fixed admin login).
2. Double-click **Start Portal.bat** (Windows) or run `./start.sh` (Mac/Linux). Your browser opens http://localhost:3000.
3. Sign in as admin, add forms under **Manage forms**, create people under **Users**.
4. Keep the black window open while people use the portal. Close it to stop.

## Roles
| Role | Forms | Complaints | Admin pages |
|---|---|---|---|
| Admin (fixed login) | all | all, can assign, update status and close | yes |
| Supervisor | all | all, can assign, update status and close | no |
| Client | all | all, same as supervisor | no |
| Staff (Operations or Facility) | only forms granted by admin | only ones assigned to or registered by them | no |

## Notifications (nothing to set up on the server)
- **New complaint:** supervisors, clients and admin are notified. **Assigned:** the staff member is notified.
  Status changes and comments notify the people involved.
- **Phone notification panel:** each person clicks **Turn on notifications** once and taps Allow.
  After that, alerts arrive in the phone's notification panel, like other apps, even when the portal is closed.
  This is free and needs no account. It only works when the portal is opened from an **https://** address
  (see "Going live"). On iPhone, first add the portal to the Home Screen (Share > Add to Home Screen), then turn notifications on.
- **Sound:** the phone plays its normal notification sound. A custom sound is not possible for web notifications.
- **While the portal is open:** a beep, a message at the bottom, counts on the Notifications button, the Complaints menu
  and the browser tab title, and new items highlighted in the list.

## Excel copies of complaints and users
- **Download:** the **Download complaints (Excel)** button (Complaints page) and **Download users (Excel)** button (Users page, admin only)
  give a file that opens in Excel. Passwords are never included.
- **Live updating:** admin clicks **Live link for Excel**, copies a link, and in Excel uses Data > Get Data > From Other Sources > From Web.
  Then set the query to refresh every few minutes (Data > Queries & Connections > Properties). Excel must be able to open the portal address.
  Anyone holding the link can read the data; use **Make new links** to cancel old ones.

## Keeping your data safe
- Everything (users, forms, complaints) is stored in a folder called **SCM-Portal-Data** inside your user folder
  (for example `C:\Users\YourName\SCM-Portal-Data`). It is outside the portal program folder on purpose:
  **installing a new version never touches it, so there is nothing to copy.** Just run the new version on the same computer.
- If you used an older version that kept data in the portal's own `data` folder, it is copied to the new place automatically the first time you start.
- The portal keeps a daily copy in `SCM-Portal-Data\backups` (the last 14 days). To restore: close the portal, copy a backup file over `db.json`, start it again.
- When it starts, the window shows where the data is stored and how many users it found.
- Moving to another computer: copy the whole `SCM-Portal-Data` folder to the same place on the new computer.
- On web hosts, set the `DATA_DIR` setting to a folder on a persistent disk. On free hosting plans the disk is usually wiped when the service restarts or sleeps, so data is lost.

## Permanent online folder (GitHub)
Hosts with free plans wipe the disk when the service restarts or sleeps. To make the data permanent, the portal saves
`db.json` (users, forms, complaints) and `vapid.json` (notification keys) into a **private GitHub repository** in your own free account.
Changes are sent within a few seconds, retried if GitHub is unreachable, and every save is a commit, so GitHub's history keeps older versions.
When the portal starts it downloads the files from GitHub first, so a wiped disk loses nothing. If GitHub cannot be reached at start-up,
the portal refuses to start rather than begin empty and overwrite your data.

**One-time setup**
1. On github.com create a new repository, e.g. `scm-portal-data`, set to **Private**. (It holds password hashes, so it must never be public.)
2. GitHub > Settings > Developer settings > Personal access tokens > **Fine-grained tokens** > Generate new token.
   Repository access: **Only select repositories** > your data repository. Permissions > Repository > **Contents: Read and write**.
   Set the longest expiry offered (or no expiry) and note the date in your calendar.
3. On the host set environment variables `GITHUB_REPO=yourname/scm-portal-data` and `GITHUB_TOKEN=github_pat_...`
   (or, running on your own computer, fill `githubRepo` and `githubToken` in `config.js`). Optional: `GITHUB_BRANCH`, `GITHUB_FOLDER` (default `data`).
4. Start the portal. The window should say **GitHub storage is on**. An existing `db.json` is uploaded automatically the first time.

**Warnings and backup**
- If saving to GitHub fails (expired token, outage, wrong settings), admin sees a **red bar** on every page until it works again.
- Admin: **Users > Download backup** gives a full copy as one `.json` file. Do this monthly and keep it on your phone or in email.
  It contains password hashes, so keep it private. To restore, put that file in the repository as `data/db.json` (GitHub > Add file > Upload) and restart the portal.
- Do not delete the repository or close the GitHub account, and run only ONE portal instance against one repository.

## Install as an app on Android
Host the portal on an HTTPS address, open it in Chrome on the phone, tap the menu, then **Install app**, then sign in and tap **Turn on notifications**.
For a real .apk file, paste the portal address into https://www.pwabuilder.com and choose Android.

## Going live
- Put it behind HTTPS (a reverse proxy such as Nginx or Caddy, or a host like Render/Railway/Azure App Service). Set `COOKIE_SECURE=1`.
- Data (`db.json`, `vapid.json`) must be on persistent storage. If `vapid.json` is lost, people just open the app once and it re-registers their phone automatically.
- Env vars override config: `PORT`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `DATA_DIR`.
- Sign-ins reset when the server restarts.
