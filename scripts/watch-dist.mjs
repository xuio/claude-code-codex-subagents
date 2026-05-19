import { chmod } from "node:fs/promises";
import { context } from "esbuild";

const outfile = "dist/index.js";

const ctx = await context({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile,
  banner: {
    js: "#!/usr/bin/env node",
  },
  plugins: [
    {
      name: "chmod-dist",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length > 0) return;
          await chmod(outfile, 0o755);
          console.log(`rebuilt ${outfile}`);
        });
      },
    },
  ],
});

await ctx.watch();
console.log(`watching src/index.ts and dependencies; writing ${outfile}`);
