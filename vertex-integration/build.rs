// build.rs — Tashi Vertex consensus static library linker
//
// The pre-built libvertex_bridge.a is provided by Tashi when you register
// for the hackathon at https://tashi.gg
//
// To enable real Vertex FFI:
//   1. Place the platform-specific libvertex_bridge.a in this directory
//   2. Uncomment the two lines below
//
// Without the library, the bridge runs in Vertex-compatible simulation mode
// (same consensus algorithm, same API, same FoxMQ topic schema).

fn main() {
    // Uncomment when libvertex_bridge.a is available:
    // println!("cargo:rustc-link-search=native=.");
    // println!("cargo:rustc-link-lib=static=vertex_bridge");
    println!("cargo:rerun-if-changed=libvertex_bridge.a");
    println!("cargo:rerun-if-changed=build.rs");
}
