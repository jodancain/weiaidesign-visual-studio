# Rebuilding the production Next app (`weiaidesign-web`) on Windows `ai`

Production source of truth lives in WSL: `/home/qrrwi/dev/weiaidesign-web` (not a git repo).
Compose project `weiaidesign-web`, container `weiaidesign-web`, port 18191, data volume
`weiaidesign-web_weiaidesign-data` mounted at `/data`.

Two facts make the naive `docker compose up --build` fail from an SSH session:

- Docker Desktop's WSL integration is broken in the Ubuntu distro (`docker` not found inside WSL).
- Windows-side `docker compose -f \\wsl.localhost\...` cannot open the UNC path (`network name cannot be found`).
- Anything started directly from the SSH session dies when the session closes.

Working procedure (2026-09-30):

1. Sync patched files into WSL (from the Mac):
   ```bash
   tar czf - -C web app/video/page.tsx app/globals.css app/api/v1/health/route.ts \
     | ssh qrrwi@100.84.235.123 'wsl -d Ubuntu -- bash -c "cd /home/qrrwi/dev/weiaidesign-web && tar xzf -"'
   ```
2. Mirror WSL -> Windows build dir `C:\Users\qrrwi\build\weiaidesign-web` (inside WSL, `.env` included,
   `node_modules`/`.next` excluded):
   ```bash
   rsync -a --delete --exclude node_modules --exclude .next --exclude tsconfig.tsbuildinfo \
     /home/qrrwi/dev/weiaidesign-web/ /mnt/c/Users/qrrwi/build/weiaidesign-web/
   ```
3. Build detached via a one-shot Scheduled Task (`build-web.ps1` -> log `C:\Users\qrrwi\build\weiaidesign-web-build.log`):
   ```
   schtasks /Create /TN WeiaiWebBuild /SC ONCE /ST 00:00 /RL HIGHEST /F /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\qrrwi\build\build-web.ps1" && schtasks /Run /TN WeiaiWebBuild
   ```
   Wait for `=== build exit 0 ===` in the log (about 20 s with warm cache; `npm ci` layer is cached).
4. Recreate the container on the new image and check health (`up-web.ps1`, uses `-p weiaidesign-web` so the
   existing data volume is reused; safe to run in the SSH session, it finishes in ~10 s).
5. Verify: `https://weiaidesign.com/api/v1/health` (`story_mode_available`), `/video` page markup.

Rollback: the previous image stays in `docker image ls` as a dangling `weiaidesign-web-web` layer; re-tag and `up-web.ps1`.
