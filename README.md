# Valenced plugins

Plugins for [Valenced](https://github.com/Valenced/valenced), the Discord mobile client mod.

## Catbox Uploader

Send files bigger than your Discord upload limit without Nitro. When you attach a file over the
limit, the plugin uploads it to [catbox.moe](https://catbox.moe), [Litterbox](https://litterbox.catbox.moe)
or [Pomf](https://pomf.lain.la) and sends the link to the chat instead. Your message text stays with the link.

Ported from the Revenge [catbox.moe plugin](https://github.com/shipwr3ckd/revengeplugin/tree/master/plugins/catbox.moe)
by シグマ siguma.

### Install

Add this repository in Valenced, so it can install the plugin and offer updates:

1. In Discord, open **Settings > Valenced > Plugins > Advanced**.
2. Paste this URL into **Repository URL** and tap **Add repository**:

   ```
   https://raw.githubusercontent.com/ndb1995/valenced-plugins/main/index.json
   ```

3. Install and enable **Catbox Uploader**. Its settings appear under the Valenced section of Discord's settings.

Or install it by hand: download [`release/ndb1995.catbox-upload@1.0.0.zip`](release/ndb1995.catbox-upload@1.0.0.zip)
and pick it under **Settings > Valenced > Plugins > Advanced > Install from file**.

### How it works

- Files under your upload limit go to Discord as usual.
- Bigger files go to your chosen host. If the file is too big for that host, or the upload fails, the
  plugin tries the next host: Catbox (permanent, up to 200 MB), Litterbox (temporary, up to 1 GB),
  Pomf (up to 1 GB).
- A toast shows upload progress. Several large files attached to one message end up in one link message.
- After the upload, the plugin sends the link, adds it to your next message in that chat, or copies it,
  depending on the **After uploading** setting.
- If every host fails, Discord's failed message stays in the chat so you don't lose what you typed.

### `/litterbox`

`/litterbox duration:24` sends your next upload to Litterbox and keeps it for 1, 12, 24 or 72 hours
(other values are rounded, and `3d` also works). Leave out the duration to use the default expiry.
Valenced has no command API, so the command is added to Discord's built-in command list. Turn it off
in the settings if it causes trouble.

### Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Upload to | Catbox | Preferred host. |
| Litterbox expiry | 3 days | Used when a file goes to Litterbox. |
| Your Discord upload limit | 10 MB | Free 10 MB, Nitro Basic or Level 2 server 50 MB, Level 3 server 100 MB, Nitro 500 MB. |
| After uploading | Send the link in chat | Or add it to your next message, or copy it. |
| Upload every file | Off | Also reroutes files under your limit. |
| Try other hosts if one fails | On | |
| Show file name instead of URL | On | Sends `[video.mp4](https://…)` instead of the bare URL. |
| /litterbox command | On | |
| Catbox userhash | Empty | Optional. Puts Catbox uploads in your catbox.moe account. |
| Proxy URL | Empty | Advanced. Sends uploads through a proxy server, for networks that block catbox. Uses the same `/direct` protocol as the original plugin. |
| Rewrite links through proxy | Off | Advanced. Links point at the proxy instead of the host. |

### Changes from the Revenge plugin

- Your message text is sent with the link. The original deleted the failed message, text included.
- Several files in one message produce one link message.
- Uploads fall back to another host when one fails.
- Toasts show upload progress.
- The upload limit setting matches your plan or server boost.
- One **After uploading** choice replaces three overlapping toggles. The plugin now sends the link by
  default instead of copying it.
- Litterbox expiry is a fixed choice instead of free text.
- The plugin no longer uploads junk "warm-up" files to catbox and Litterbox every time it starts.
- Insert mode only adds the link to your next message in the same chat.

### Limitations

- This plugin hasn't been tested on a device yet. It uses the same Discord internals as the Revenge
  plugin (`CloudUpload`, the pending message store, `getBuiltInCommands`). If a Discord update renames
  them, the plugin leaves uploads alone and logs a warning.
- If one message has a small file and a large file, the small file is lost with the failed message.
  Turn on **Upload every file** if you often mix them.
- Very old Discord versions may need a different toast format. The plugin tries both.

## Building

The source follows the [Valenced plugin template](https://github.com/Valenced/valenced-plugin-template)
layout: `plugins/catbox-upload/manifest.json` and the entry point at `plugins/catbox-upload/js/index.tsx`.

```sh
npm install        # @valenced/types installs from GitHub
npm run typecheck
npm run build      # writes the plugin script, release/<id>@<version>.zip and index.json
npm test           # runs the plugin bundle against mocked Discord modules
```

`scripts/build.mjs` replaces the template's `valenced-plugin build`. Valenced runs plugin scripts before
React and Discord's UI load. So the script gets every Valenced and React value through a lazy proxy
that resolves when first used, then lowers syntax with Valenced's Hermes settings. It also loads the
built script against a proxy that throws on any access, to prove nothing is read too early.
