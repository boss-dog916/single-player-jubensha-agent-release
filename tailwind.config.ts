import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#f4e9df",
        paper: "#171114",
        mist: "#271b1f",
        ember: "#c96562",
        pine: "#aa4350",
        brass: "#d5ad68"
      },
      boxShadow: {
        panel: "0 18px 45px rgba(0, 0, 0, 0.38)"
      }
    }
  },
  plugins: []
};

export default config;
