# Code signing policy

## Current status

SignPath integration is prepared but is not active until the project has been accepted by SignPath Foundation, production signing has been configured, and a new signed release has passed verification. Existing Windows releases are not retroactively signed. Check the particular downloaded file's Digital Signatures tab rather than assuming that every release is signed.

The intended service attribution, applicable only after approval, is: “Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).” This statement does not claim current sponsorship or approval.

## Team and release approval

- Author / committer: [nanshine](https://github.com/nanshine).
- Reviewer: [nanshine](https://github.com/nanshine); changes from external contributors require maintainer review before inclusion in a release.
- Signing approver: [nanshine](https://github.com/nanshine). Production signing requests require explicit maintainer approval in SignPath; possessing an API token must not grant approval rights.

All maintainers must enable multi-factor authentication on GitHub and SignPath before production signing is enabled. Only this repository's GitHub-hosted release builds are eligible for signing. The application and the installer have separate requests, both restricted to FloatNote product metadata and the release version. Upstream executable components must not be signed using this project's certificate.

## Privacy policy

Notes, project files, settings and chat history are stored locally. Using the AI assistant sends the requested content and relevant project context to the provider configured by the user; web search and web fetch tools may also contact external services and websites. Consult the selected AI provider's privacy policy before sending sensitive content.

Release builds check GitHub-hosted update manifests shortly after startup and periodically thereafter, as well as when the user requests a check. These connections expose ordinary connection metadata such as the IP address to GitHub. Downloading and installing an update requires user confirmation. See [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). The app uses Microsoft WebView2 on Windows; see [Microsoft's privacy statement](https://privacy.microsoft.com/privacystatement). Website feedback explicitly submitted by the user includes their message, optional email address and interface language and is stored using Cloudflare services; see [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).

This policy describes current network behavior, including automatic update checks; it does not claim that the application never connects without a user action. Any additional disclosure or opt-out required during SignPath review must be implemented before enabling production signing.

## Verification and limitations

The release workflow validates Windows trust, the approved publisher, a timestamp and FloatNote product/version metadata before generating the Tauri updater signature and uploading the installer. Renaming the verified installer preserves its bytes; published files must not be replaced in place. The NSIS-generated uninstaller and third-party components are outside the current two-file signing scope; this limitation must be disclosed to SignPath during review.

A valid code signature identifies the publisher and detects modification; it does not guarantee that SmartScreen or other security software will show no warning. Report suspected tampering through a [repository issue](https://github.com/nanshine/FloatNote/issues), including the release version and SHA-256, without posting personal files or credentials.
