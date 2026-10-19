// An example, not a use: pantry_macros::shelf!()
use std::env;

fn main() {
    let name = env::args().nth(1).unwrap_or_default();
    let item = pantry_core::Item { name, count: 1 };
    println!("{} x{} (see shelf::docs)", item.name, item.count);
}
