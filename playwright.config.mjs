import { defineConfig } from "@playwright/test";

// Force software GPU backends so both flows work in headless Chromium on CI
// machines with no discrete GPU. (Dev-only; not in the package `files` list.)
//
// Two projects, one per backend. Each carries its scene in `use.scene`, which the
// spec reads to pick the ?scene= query the smoke page loads:
//   - webgl2: SwiftShader WebGL2 (the v1.x baseline).
//   - webgpu: SwiftShader/Vulkan WebGPU (the v2.0.0 sink + deferred pick).
export default defineConfig({
    timeout: 30000,
    projects: [
        {
            name: "webgl2",
            use: {
                scene: "webgl2",
                launchOptions: {
                    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
                },
            },
        },
        {
            name: "webgpu",
            use: {
                scene: "webgpu",
                launchOptions: {
                    args: [
                        "--enable-unsafe-webgpu",
                        "--enable-features=Vulkan",
                        "--use-angle=swiftshader",
                        "--use-webgpu-adapter=swiftshader",
                    ],
                },
            },
        },
    ],
});
