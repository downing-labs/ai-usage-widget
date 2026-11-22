# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - Unreleased

First version.

### Added
- Usage meters for Claude (5-hour, weekly), ChatGPT (5-hour, weekly), Muse (weekly) and Gemini (5-hour, weekly).
- Claude, ChatGPT and Muse are read from your own signed-in sessions.
- Gemini is read through an opt-in Chrome companion extension and a local, token-protected bridge on 127.0.0.1.
- Pick which tools to show, reorder them, and choose per tool whether the weekly meter is always shown or only when high.
- Tray icon that shows the highest meter or a pinned tool, with a red dot when another tool is running low and an at-limit tooltip.
- Per-tool card colors, light, dark or system theme, compact mode, 12/24-hour time, always on top, and warn and danger levels.
- Update check against this repository's GitHub releases.
- Windows installer and portable builds.
