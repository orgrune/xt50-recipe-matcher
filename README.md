# X-T50 Recipe Matcher

Drop in a photo whose look you want to reproduce and it tells you which Fujifilm X-T50 settings to change to get close to that colour profile.

**Use it in the browser:** https://orgrune.github.io/xt50-recipe-matcher/ (installable as a PWA, works offline after the first visit). Or run it as a macOS desktop app (Electron).

Everything is computed locally from the pixels on your Mac or phone. No uploads, no network calls, no API keys. Your current camera settings are cached in the browser's local storage on the device you use.

## Download

Grab the latest DMG from the [Releases page](https://github.com/orgrune/xt50-recipe-matcher/releases) (Apple Silicon and Intel builds). The app is not code-signed, so on first launch right-click it and choose Open, or run once:

```bash
xattr -dr com.apple.quarantine "/Applications/X-T50 Recipe Matcher.app"
```

## Run it from source

```bash
npm install
npm start
```

To build a double-clickable app bundle in `dist/mac-arm64/`:

```bash
npm run dist
```

The bundle is unsigned, so on first launch right-click the app and choose Open.

## How it works

1. The image is downscaled and measured: luminance percentiles and clipping, saturation and colourfulness, colour cast on near-neutral pixels, highlight and shadow tint relative to the midtones, mid-frequency local contrast, and (from a native-resolution centre crop) noise and edge acutance.
2. Each colour film simulation has a small feature profile (saturation, contrast, fade, shadow and highlight tint). The image is scored against every one and the closest wins. Monochrome images are routed to ACROS or Monochrome.
3. The remaining IQ-menu settings are derived from the measurements relative to the chosen simulation: Highlight and Shadow tone, Color, White Balance and WB shift, Dynamic Range, Grain, Color Chrome Effect and FX Blue, Clarity, Sharpness, High ISO NR, Monochromatic Color and exposure compensation.

## Telling the app what your camera is set to

Your X-T50 writes every IQ-menu setting into the EXIF maker note of each JPEG. So the quickest route is:

1. Shoot any frame on the camera (JPEG or RAW+JPEG).
2. Drop that JPEG into the app. A banner says "Shot on FUJIFILM X-T50" with a button to use its settings as your current settings. Or open "My current settings" and choose "Read from a camera JPEG…".

Edited or re-exported files usually lose the maker note, so use the file straight off the card. You can also type the values in by hand, or check them on the camera: in playback, press DISP/BACK to cycle to the info page that lists film simulation, WB, DR and tone.

Click "My current settings" to see or edit what the app thinks your camera is set to.

## Guide screen

The Guide button opens a walkthrough built from the current recipe: the exact dial and Q-menu moves to set the look in the field, how to save it into one of the seven custom settings banks (C1–C7) and recall it, and a cheat sheet of which film simulations have fixed positions on the Film Simulation dial versus the FS1–FS3 slots. The table then marks each row keep or change, and "Copy recipe" puts the whole thing on the clipboard.

## Releasing

Releases are built by GitHub Actions. Bump the version in `package.json`, then push a tag:

```bash
git tag v1.0.1 && git push origin v1.0.1
```

The workflow builds the DMG and zip for both architectures on a macOS runner and attaches them to a GitHub Release with generated notes.

## Web app

The renderer has no Node dependencies, so the same files serve as a static site. GitHub Pages publishes the repository root. A small service worker caches the app shell and fonts so the page opens offline, and settings you enter under "My current settings" persist in `localStorage` on that browser.

To run it locally in a browser:

```bash
python3 -m http.server 8765
```

then open http://localhost:8765.

## Contributing

Issues and pull requests are welcome. The film-simulation profiles in `analyzer.js` are heuristic starting points; if you have measured data or better recipes, that is the most useful place to contribute.

## Credits

Fonts: [Inter](https://rsms.me/inter/) and [Space Mono](https://fonts.google.com/specimen/Space+Mono), both under the SIL Open Font License. Fujifilm maker-note tag maps follow [ExifTool](https://exiftool.org/). Not affiliated with Fujifilm.

## Limits

- This is a heuristic model of Fujifilm's simulations, not a colour-science match. Treat the output as a strong starting point and fine-tune by eye.
- WB shift is inferred from the image cast, so it assumes the source was shot in roughly neutral light.
- Sharpness and grain read low on images that were resized or heavily compressed.
- HEIC and RAW files are not decoded. Export a JPEG first.
