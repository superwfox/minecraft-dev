package com.tahai.originalplugin.greeting;

import org.bukkit.Bukkit;

public class GreetingService {
    private static final String GREETING = "Hello server";

    public GreetingService() {
    }

    public void greet() {
        Bukkit.getLogger().info(GREETING);
    }
}