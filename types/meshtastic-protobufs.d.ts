/**
 * @meshtastic/protobufs ships its types as `dist/mod-<hash>.d.ts` but its
 * package.json points the `types` field at `./dist/mod.d.ts` which does not
 * exist. We avoid patching node_modules by declaring the module as `any`-
 * typed. The runtime behaviour is unchanged; we lose autocomplete on the
 * handful of generated schema identifiers we use inside meshtastic.service.ts.
 */
declare module '@meshtastic/protobufs';
