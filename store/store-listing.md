# Chrome Web Store – submission texts

Copy each block into the matching field in the Chrome Web Store Developer Dashboard.
Upload the package built by `scripts/build.sh` (`dist/comment-cleaner-for-9gag-<version>.zip`).

---

## Store listing tab

**Name** (from manifest)
```
Comment Cleaner for 9GAG
```

**Summary / short description** (max 132 characters; taken from the manifest `description`)
```
Find all your 9GAG comments and replies, select them by date and delete them in bulk.
```

**Category**
```
Productivity → Tools
```
(If the dashboard offers only one level: "Tools".)

**Language**
```
English
```

**Detailed description**
```
Clean up your 9GAG comment history in minutes.

9GAG has no way to list or delete your own comments in bulk – you would have to find every post you ever commented on and delete each comment one by one. Comment Cleaner for 9GAG does that for you.

HOW IT WORKS
• Sign in to 9gag.com as usual – the extension detects your account automatically.
• Click "Load my comments". The extension goes through every post you have commented on and finds all of your comments and replies, including ones buried deep in reply threads.
• Review them in a sortable table: date, post, score and text, with a link to each comment.
• Select what you want to remove and click "Delete selected".

FEATURES
• Fast parallel scanning that starts as soon as the first posts arrive
• Progress bar with an estimate of the remaining time
• Quick selection: older than 1 hour / day / week / month, the latest N comments, a date range, select all, invert
• Sort by date, post, score, content or status
• Log of every action, including any errors
• Optional switching between several 9GAG accounts without signing out

PRIVACY
Everything runs locally in your browser. The extension talks only to 9gag.com, using the same requests the 9GAG website makes when you browse it while signed in. There is no server, no analytics and no tracking, and your password is never seen by the extension.

PLEASE NOTE
• Deleting comments is permanent and cannot be undone. Try it on one or two old comments first.
• 9GAG does not allow editing comments, so comments are deleted, not overwritten. A comment that has replies is shown by 9GAG as "deleted" and the replies remain.
• The extension uses 9GAG's unofficial web API, which may change at any time.

Comment Cleaner for 9GAG is an independent project and is not affiliated with, endorsed by or sponsored by 9GAG.
```

**Graphic assets** (files in this folder)
- Store icon 128×128: `../extension/icons/icon128.png`
- Screenshot 1280×800: `screenshot-1.png`
- Small promo tile 440×280: `promo-small-440x280.png`
- Marquee promo tile 1400×560: `promo-marquee-1400x560.png`

**Homepage URL**
```
https://rakuscinec.github.io/comment-cleaner-for-9gag/
```

**Support URL**
```
https://github.com/rakuscinec/comment-cleaner-for-9gag/issues
```

---

## Privacy practices tab

**Single purpose description**
```
The extension has a single purpose: it finds the signed-in user's own comments on 9gag.com and lets the user delete the selected ones in bulk. Optional switching between saved 9GAG accounts only serves this purpose (cleaning comments of several accounts).
```

**Permission justifications**

`scripting`
```
Used to run the extension's requests inside a 9gag.com tab, so they use the user's existing 9GAG sign-in exactly like the 9GAG website does: reading the user's identity, listing the posts they commented on, reading comments under those posts and deleting the comments the user selected. No code is injected into any other site.
```

`tabs`
```
Used to find an open 9gag.com tab (or open one in the background) to run the requests above, to open the 9GAG sign-in page when the user adds an account, to close that sign-in tab after sign-in is detected, and to focus the extension's own page when its toolbar icon is clicked.
```

`storage`
```
Used to store, locally in the browser, the list of 9GAG accounts the user has added for account switching and which one is active. Nothing is synced or sent anywhere.
```

`cookies`
```
Used only for the optional multi-account feature: when the user adds a 9GAG account, the extension saves that account's 9gag.com cookies in local extension storage. When the user switches accounts, it clears the 9gag.com cookies and restores the saved ones, so the user can clean comments of several accounts without signing out and in again. Only 9gag.com cookies are read or written.
```

Host permission `https://*.9gag.com/*`
```
Required to read the user's own comments from 9gag.com and comment.9gag.com and to delete the comments the user selects. The extension does not access any other site.
```

**Are you using remote code?**
```
No, I am not using remote code.
```
(All JavaScript is bundled in the package. The extension only fetches JSON data from 9GAG's API.)

**Data usage** – tick these categories:
- [x] **Authentication information** – 9GAG session cookies (only when the user adds an account for switching) and the 9GAG comment authorization token.
- [x] **Personally identifiable information** – 9GAG username and account ID.
- [x] **User activity** – the user's 9GAG comments and the posts they commented on, shown in the table.
- [x] **Website content** – comment text loaded from 9gag.com.

Leave all other categories unticked (health, financial and payment, personal communications, location, web history).

Tick all three certifications:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**
```
https://rakuscinec.github.io/comment-cleaner-for-9gag/privacy-policy.html
```

---

## Distribution tab

- Visibility: Public (or Unlisted for a test run first)
- Regions: All regions
- Pricing: Free

## Notes for the reviewer (optional field "Test instructions", if requested)
```
A 9GAG account with at least one comment is needed. Sign in to 9gag.com, click the extension icon, then "Load my comments". Deleting is only performed after the user selects comments and confirms in a dialog.
```
