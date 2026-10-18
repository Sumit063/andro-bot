# Android tablet setup

Everything on the tablet happens in **Chrome**; there's no app to install. This guide covers the
one-time settings that make it feel like a dedicated device, including the microphone for the
"NO SHOUTING!" reaction.

Replace `http://192.168.1.20:8765` below with the address `./start.sh` prints on your Mac.

## 1. Open the page

1. Connect the tablet to the **same Wi‑Fi** as the Mac.
2. Open Chrome and go to `http://<mac-ip>:8765`.
3. **Tap once.** This goes full screen and unlocks sound (browsers block audio until you touch the page).

## 2. Allow the microphone (Chrome flag)

Chrome only gives web pages the microphone on secure (`https://`) addresses. The hub runs on plain
`http://` on your home network, so you tell Chrome to trust that one address:

1. In Chrome's address bar open:
   ```
   chrome://flags/#unsafely-treat-insecure-origin-as-secure
   ```
2. The highlighted entry is **"Insecure origins treated as secure"**. In its text box enter your hub
   address **exactly**, including `http://` and the port, with no trailing slash:
   ```
   http://192.168.1.20:8765
   ```
   (Several addresses can be separated with commas.)
3. Change the dropdown next to it from **Default** to **Enabled**.
4. Tap **Relaunch** at the bottom. Chrome restarts.
5. Open the page again and **tap once**. Chrome asks to use the microphone: choose **Allow**
   (or "Allow every visit" / "While visiting the site").

Check it worked: tap the screen to show the dock. The **Mic** button should be on, with a moving
level meter next to it. Android also shows its green "microphone in use" dot while the page listens.

> **Why this is safe enough:** the flag only affects the single address you typed. Your Mac and
> tablet talk directly over your home Wi‑Fi. Audio is analysed in memory on the tablet only and is
> never recorded, stored or sent anywhere.

Bonus: once the address counts as secure, Chrome can also **keep the screen awake** by itself and
**install the page as an app** (step 4).

### If the mic doesn't work

| Symptom | Fix |
|---|---|
| Dock hint "Mic needs the Chrome flag…" | The address in the flag doesn't match the one in the address bar (check `http://`, IP and port), or Chrome wasn't relaunched. |
| Dock hint "Mic blocked…" | You tapped *Block*. Chrome → ⋮ → Settings → Site settings → Microphone → find the address → Allow. Also check Android Settings → Apps → Chrome → Permissions → Microphone. |
| Mac's IP changed | Update the address in the flag (and reserve a fixed IP for the Mac in your router to avoid this). |

## 3. Tune the shouting detector

Open the dock while people talk normally near the tablet:

- **Green bar** = how loud the room is right now
- **Red mark** = the shouting threshold

Normal talking should stay clearly left of the red mark. Adjust in `config.json` on the Mac (applies within seconds):

```json
"mic": { "sensitivity": 0.5 }
```

| It reacts to… | Change |
|---|---|
| Normal talking / TV | Lower it: `0.3`, then `0.2` |
| Nothing, even real shouting | Raise it: `0.6`, then `0.7` |

Other built-in behaviour: it is less sensitive while the Mac is playing media, ignores its own
sounds, reacts at most once every 40 s, and stops listening during `quietHours` (default 23:00–08:00).
Turn it off any time with the **Mic** button in the dock. Preview the reaction with `?demo=shout`.

## 4. Make it feel like a dedicated screen (optional)

- **Keep the screen on:** Settings → About tablet → Software information → tap **Build number** 7 times →
  back to Settings → **Developer options** → turn on **Stay awake** (screen stays on while charging).
  Keep the tablet plugged in.
- **Install as an app:** Chrome menu ⋮ → **Add to Home screen** / **Install app**. It then opens
  full screen with its own icon. With the flag from step 2 it installs as a real app; without it you get a
  shortcut that opens in a normal tab.
- **Auto-rotate:** lock the tablet in landscape; the layout is designed for it.
- **Do not disturb / notifications:** silence notifications so pop-ups don't cover the screen.

## 5. Everyday notes

- After the page reloads (it reloads itself when the app is updated), **tap once** again to re-enable
  sound and the mic. A hint at the bottom reminds you.
- Tap anywhere → dock: *Auto · Bot · Clock · Media* and *Sound · Mic* toggles, plus the live latency to the Mac.
- Pin a view with `?view=bot`, `?view=clock` or `?view=media` in the address.
