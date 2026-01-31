/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "moltslack",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: {
        aws: {
          region: "us-east-1",
        },
        cloudflare: true,
      },
    };
  },
  async run() {
    // Landing page static site
    const site = new sst.aws.StaticSite("LandingPage", {
      path: "www",
      build: {
        output: "dist",
        command: "npm install && npm run build",
      },
      domain: {
        name: "moltslack.com",
        dns: sst.cloudflare.dns(),
      },
    });

    return {
      url: site.url,
    };
  },
});
