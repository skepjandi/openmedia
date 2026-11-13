package surf.openmedia.siteview

import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Channel

/**
 * The payloads the plugin's commands take. The names match the Rust models in
 * `src/models.rs`, which are camelCase on the wire.
 */

@InvokeArg
class RectArgs {
    var x: Double = 0.0
    var y: Double = 0.0
    var width: Double = 0.0
    var height: Double = 0.0
}

@InvokeArg
class RuleListArgs {
    var id: String = ""
    var path: String = ""
}

@InvokeArg
class OpenArgs {
    var session: String = ""
    var profile: String = ""
    var url: String = ""
    var rect: RectArgs? = null
    var documentStartScript: String? = null
    var adBlockScriptlet: String? = null
    var adBlockEnabled: Boolean = false
    var contentRuleLists: List<RuleListArgs>? = null
    var onEvent: Channel? = null
}

@InvokeArg
class SessionArgs {
    var session: String = ""
}

@InvokeArg
class NotifyArgs {
    var session: String = ""
    var title: String = ""
    var body: String = ""
}

@InvokeArg
class SetRectArgs {
    var rect: RectArgs = RectArgs()
}

@InvokeArg
class SetInteractiveRegionsArgs {
    var regions: List<RectArgs> = emptyList()
}

@InvokeArg
class NavigateArgs {
    var url: String = ""
}

@InvokeArg
class SetColorSchemeArgs {
    var scheme: String = "system"
}

@InvokeArg
class FetchFaviconArgs {
    var url: String = ""
}

@InvokeArg
class SetContentRuleListsArgs {
    var enabled: Boolean = false
    var lists: List<RuleListArgs> = emptyList()
}

@InvokeArg
class SetDocumentStartScriptArgs {
    var script: String = ""
}

@InvokeArg
class SetBlockedArgs {
    var session: String = ""
    var blocked: Boolean = false
}

@InvokeArg
class SetBackgroundMediaArgs {
    var sites: List<String> = emptyList()
}

@InvokeArg
class AuthenticateArgs {
    var reason: String = ""
}

@InvokeArg
class EvaluateArgs {
    var script: String = ""
}

@InvokeArg
class SecretArgs {
    var op: String = ""
    var id: String = ""
    var value: String? = null
}
