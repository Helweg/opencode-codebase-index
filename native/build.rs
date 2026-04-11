extern crate napi_build;

fn main() {
    napi_build::setup();

    // 设置 cfg 标志，用于在测试时禁用 SIMD
    if cfg!(feature = "testing") {
        println!("cargo:rustc-cfg=testing");
        println!("cargo:warning=Testing mode: SIMD disabled for stability");
    }
}
