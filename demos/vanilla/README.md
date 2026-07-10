# YumCut Video Ads · vanilla TypeScript demo

A framework-free Vite consumer of the root `yumcut-video-ads` package. It exercises the complete
browser workflow: bundled HTTP template, local video and audio uploads, support detection, source
analysis, cancellable rendering, preview, download, and result cleanup.

```sh
cd demos/vanilla
npm install
npm run dev
```

Open the printed localhost URL in a current Chromium browser. `public/media` contains standalone
copies of all three redistributable video templates and the synthetic sample audio track, so the demo
works from a GitHub archive or on platforms without Git symlink support. See
`public/media/ATTRIBUTION.md` and the repository-root `MEDIA_LICENSES.md` for licensing details.
