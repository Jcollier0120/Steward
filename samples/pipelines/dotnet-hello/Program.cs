Console.WriteLine(Hello.Say("world"));

static class Hello
{
    public static string Say(string who) => $"Hello, {who}!";
}
