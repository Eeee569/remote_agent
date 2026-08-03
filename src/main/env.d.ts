/**
 * Ambient module declarations for the main-process build.
 * electron-vite (Vite) resolves `?raw` imports to the file's source string;
 * used to embed server-helper/helper.py and tmux.conf into the bundle.
 */
declare module '*?raw' {
  const src: string
  export default src
}
