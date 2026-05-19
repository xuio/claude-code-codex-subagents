## Summary

-

## Validation

- [ ] `npm run test:ci`
- [ ] `npm run check:dist`
- [ ] Real Claude/Codex validation, if the change affects live integration

## Safety

- [ ] Default behavior remains read-only unless this PR intentionally changes it
- [ ] No credentials, private logs, local auth data, or machine-specific artifacts are committed
- [ ] `dist/index.js` is rebuilt when TypeScript source changes
