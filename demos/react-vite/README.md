# YumCut Video Ads — React + Vite demo

A production-buildable React 19 and Vite 8 consumer of the package in the repository root.

## Run it

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. The app can:

- choose any of the three bundled video templates;
- upload a foreground video and soundtrack;
- use the bundled sample soundtrack for a no-setup render;
- compose landscape or portrait HD output with aspect-safe `cover` fitting;
- inspect browser support, analyze the real project, render, cancel, preview, and download;
- revoke object URLs and release temporary output when a result is replaced or the app unmounts.

`yumcut-video-ads` is installed with `file:../..`, so this demo exercises the same package exports that an external Vite app consumes while remaining easy to develop in this repository.

## Production build

```bash
npm run build
npm run preview
```

The demo processes uploaded files locally. It makes no analytics or third-party font requests; the only HTTP requests are same-origin app, library worker, and bundled media assets.
