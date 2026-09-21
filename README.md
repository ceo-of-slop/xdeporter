# X Deporter

Shows the country or region X reports for each account in small blue text below its display name. Hide posts from countries you select, or show only selected countries. Unknown locations can be hidden too.

## Install in Chrome, Brave, or Edge

1. Download the **xdeporter ZIP** from [Releases](https://github.com/ceo-of-slop/xdeporter/releases). Choose the extension ZIP, not “Source code.”
2. Extract it to a folder you’ll keep on your computer.
3. Open your browser’s extensions page: `chrome://extensions`, `brave://extensions`, or `edge://extensions`.
4. Enable **Developer mode**, then click **Load unpacked**.
5. Select the extracted folder containing `manifest.json`.
6. Refresh X, then open **X Deporter** from your extensions menu to choose your filters.

To update, replace the files in the same folder, click **Reload** on the extension’s card, and refresh X.

Filters apply to the post's author, not accounts inside quotes. Pending lookups are hidden by default while filtering; use **Hide unknown locations** for accounts X cannot locate. X's label is an estimate, not proof of nationality.

**Privacy:** Settings and cached locations stay in your browser. X Deporter temporarily reads selected X session headers into extension memory to request account locations from X; it never saves those headers or sends data to third parties. Disabling lookups clears that state. X's private API can change. [Details](docs/SOURCES.md) · [Security](SECURITY.md)
