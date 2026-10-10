import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "aethercloud-console",
    compatibilityDate: "2026-07-29",
    previewUrls: false,
    assets: {
      notFoundHandling: "single-page-application",
    },
    // Both hostnames serve this Worker while aetheriot.ai replaces aetheriot.dev.
    // cloud.aetheriot.ai was once attached outside the config and so was
    // invisible to deploys; declaring it here keeps a deploy from dropping a
    // domain that is already serving. cloud.aetheriot.dev comes out once no one
    // reaches the console from it.
    domains: ["cloud.aetheriot.ai", "cloud.aetheriot.dev"],
  },
});
