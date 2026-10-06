// Tests never read the developer's ~/.config/tlgrm/config.json: a token, a port
// or an account list in it would leak into assertions, and an unreadable one
// would make every test that imports an entry point exit.
//
// Set here rather than per file because `--import` runs before any test module,
// and the node test runner passes this environment to the child it spawns per
// file.
process.env.TLGRM_CONFIG = "/nonexistent/tlgrm-test-config.json";
