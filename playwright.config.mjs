import { defineConfig } from "@playwright/test";

// Force a software GL backend so WebGL2 works in headless Chromium on CI machines
// that have no GPU. (Dev-only; not in the package `files` list.)
export default defineConfig({
    timeout: 30000,
    use: {
        launchOptions: {
            args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        },
    },
});
