// Vite turns an import with ?raw into the file's text. The unit tests use it to
// read .dev.vars.example, which the Workers runtime cannot open from disk.
declare module "*?raw" {
  const text: string;
  export default text;
}
