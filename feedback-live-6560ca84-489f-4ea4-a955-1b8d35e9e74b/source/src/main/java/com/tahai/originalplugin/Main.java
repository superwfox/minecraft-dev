package com.tahai.originalplugin;

import com.tahai.originalplugin.greeting.GreetingService;
import org.bukkit.plugin.java.JavaPlugin;

public class Main extends JavaPlugin {

    @Override
    public void onEnable() {
        GreetingService greetingService = new GreetingService();
        greetingService.greet();
    }

    @Override
    public void onDisable() {
        getServer().getScheduler().cancelTasks(this);
    }
}