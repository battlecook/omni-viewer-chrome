# Chrome Web Store Notes

## Single purpose

Omni Viewer opens user-selected local files in Chrome and renders supported formats in a local viewer.

## Permissions

- `storage`: stores small UI preferences such as the selected theme. File contents are not stored.
- `https://omni-viewer-share-624036133562.us-west1.run.app/*`: creates or opens a temporary five-minute share only after the user explicitly clicks Share or Open Link. Uploads identify the client platform as `chrome`.
- `https://identitytoolkit.googleapis.com/*` and `https://securetoken.googleapis.com/*`: create and refresh an anonymous Firebase identity used only to authenticate Share uploads.
- `https://storage.googleapis.com/*`: downloads signed Omni Viewer share URLs after validating that the path belongs to the `omni-viewer-web-share` bucket.

## Privacy

The extension reads files only after the user selects or drops them. File contents are uploaded only when the user explicitly clicks Share; the temporary share expires after five minutes. The extension does not execute remotely hosted code.

## Remote code declaration

Select "No, I am not using remote code." All viewer code and third-party libraries are packaged under the extension directory.

## Packaging

Run:

```sh
npm run lint
npm run package:chrome
```

Upload the generated zip from `dist/`.
