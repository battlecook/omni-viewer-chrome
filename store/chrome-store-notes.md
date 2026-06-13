# Chrome Web Store Notes

## Single purpose

Omni Viewer opens user-selected local files in Chrome and renders supported formats in a local viewer.

## Permissions

- `storage`: stores small UI preferences such as the selected theme. File contents are not stored.

## Privacy

The extension reads files only after the user selects or drops them. The current implementation does not upload file contents to a server and does not execute remotely hosted code.

## Remote code declaration

Select "No, I am not using remote code." All viewer code and third-party libraries are packaged under the extension directory.

## Packaging

Run:

```sh
npm run lint
npm run package:chrome
```

Upload the generated zip from `dist/`.
