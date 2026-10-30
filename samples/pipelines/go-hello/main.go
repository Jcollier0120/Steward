package main

import "fmt"

func hello(who string) string {
	return fmt.Sprintf("Hello, %s!", who)
}

func main() {
	fmt.Println(hello("world"))
}
