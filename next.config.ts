import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.OLD_HOUSE_PLAYTEST_BUILD === "true" ? process.env.OLD_HOUSE_PLAYTEST_DIST_DIR ?? ".next-old-house-playtest" : process.env.LONG_NIGHT_PLAYTEST_DIR ? ".next-long-night-playtest" : ".next",
  webpack(config, { isServer }) {
    if (isServer && config.output) {
      config.output.chunkFilename = "chunks/[name].js";
    }

    return config;
  }
};

export default nextConfig;
