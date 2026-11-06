// npm run testmail  -> sends one test email so you know alerts will arrive
require("./mail").send("[Pingerr] Test email", "If you can read this, Pingerr alerts work.").then(ok => process.exit(ok ? 0 : 1));
