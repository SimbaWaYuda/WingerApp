# Winger logo

The master logo is traced from the 161 × 148 reference. Do not redraw it.

## Master

- File: `assets/branding/winger-logo.svg`
- `viewBox="0 0 161 148"`
- Aspect ratio: 161:148
- Background `#FFFFFF`
- Blue circle: center (78, 77), radius 69 (about x=9, y=8, 138 × 138 on the canvas)
- Orange arch: about x=42–114, y=25–57
- White W: about x=41–115, y=73–122

## Colours

From `winger-colors.json`, sampled from the reference:

| Token | Hex | Use |
| --- | --- | --- |
| primaryBlue | `#2463C3` | Circle |
| accentOrange | `#E68405` | Arch |
| background | `#FFFFFF` | Canvas behind the circle |
| white | `#FFFFFF` | The W |

The in-app screen theme stays the existing dark green. These colours are for the logo, icons, and splash.

## Minimum size

Keep the full mark at least 32 px wide. Below that the arch and the W are still the same drawing, but they become hard to read. Favicons at 16 px use this same logo with no alternate mark.

## In the app

```dart
WingerLogo(size: 120)
```

`size` is the width. The height follows 161:148. The widget loads the local SVG and is the same on web, Windows, and Android.

## Favicon

- `web/favicon.svg`
- `web/favicon-16.png`, `web/favicon-32.png`, `web/favicon-48.png`
- `web/favicon.png` (32 px fallback)

## PWA

- `web/icons/Icon-192.png`
- `web/icons/Icon-512.png`
- Maskable icons use the same master.

## Android

Launcher icons are the master scaled uniformly into the mipmap sizes (48, 72, 96, 144, 192) and the adaptive foreground `drawable-nodpi/ic_launcher_art.png`. The adaptive background is `#FFFFFF`. The circle and the W are not stretched.

## Windows

`windows/runner/resources/app_icon.ico` holds 16, 32, 48, 64, 128, and 256. Matching PNGs are `winger-icon-16.png` through `winger-icon-256.png` in this folder.

## Splash

`winger-splash.png` is the logo centred on `#FFFFFF` (1080 × 1920). Android launch screens use the same logo, centred, on white.

## Store

- `winger-icon-512.png`
- `winger-icon-1024.png`

The logo is centred. There is no shadow, text, border, or gradient.
