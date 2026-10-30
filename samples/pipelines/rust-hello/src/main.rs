fn hello(who: &str) -> String {
    format!("Hello, {who}!")
}

fn main() {
    println!("{}", hello("world"));
}

#[cfg(test)]
mod tests {
    use super::hello;

    #[test]
    fn says_hello() {
        assert_eq!(hello("world"), "Hello, world!");
        assert_eq!(hello("Steward"), "Hello, Steward!");
    }
}
