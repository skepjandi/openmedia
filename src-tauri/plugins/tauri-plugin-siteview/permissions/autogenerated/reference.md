## Default Permission

Shell-only control of the native site view. `open` is deliberately absent: the app's own `open_site` command opens pages so it can attach the recipe script. `fetch-favicon` is also absent: only Rust calls it, so the shell cannot make arbitrary native fetches. Never grant to a site webview.

#### This default permission set includes the following:

- `allow-activate`
- `allow-close`
- `allow-set-rect`
- `allow-set-interactive-regions`
- `allow-set-covered`
- `allow-navigate`
- `allow-go-back`
- `allow-go-forward`
- `allow-reload`
- `allow-set-color-scheme`
- `allow-notify`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`siteview:allow-activate`

</td>
<td>

Enables the activate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-activate`

</td>
<td>

Denies the activate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-close`

</td>
<td>

Enables the close command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-close`

</td>
<td>

Denies the close command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-delete-profile-data`

</td>
<td>

Enables the delete_profile_data command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-delete-profile-data`

</td>
<td>

Denies the delete_profile_data command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-fetch-favicon`

</td>
<td>

Enables the fetch_favicon command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-fetch-favicon`

</td>
<td>

Denies the fetch_favicon command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-go-back`

</td>
<td>

Enables the go_back command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-go-back`

</td>
<td>

Denies the go_back command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-go-forward`

</td>
<td>

Enables the go_forward command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-go-forward`

</td>
<td>

Denies the go_forward command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-navigate`

</td>
<td>

Enables the navigate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-navigate`

</td>
<td>

Denies the navigate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-notify`

</td>
<td>

Enables the notify command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-notify`

</td>
<td>

Denies the notify command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-open`

</td>
<td>

Enables the open command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-open`

</td>
<td>

Denies the open command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-reload`

</td>
<td>

Enables the reload command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-reload`

</td>
<td>

Denies the reload command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-set-color-scheme`

</td>
<td>

Enables the set_color_scheme command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-set-color-scheme`

</td>
<td>

Denies the set_color_scheme command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-set-content-rule-lists`

</td>
<td>

Enables the set_content_rule_lists command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-set-content-rule-lists`

</td>
<td>

Denies the set_content_rule_lists command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-set-covered`

</td>
<td>

Enables the set_covered command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-set-covered`

</td>
<td>

Denies the set_covered command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-set-document-start-script`

</td>
<td>

Enables the set_document_start_script command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-set-document-start-script`

</td>
<td>

Denies the set_document_start_script command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-set-interactive-regions`

</td>
<td>

Enables the set_interactive_regions command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-set-interactive-regions`

</td>
<td>

Denies the set_interactive_regions command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-set-rect`

</td>
<td>

Enables the set_rect command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-set-rect`

</td>
<td>

Denies the set_rect command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:allow-set-visible`

</td>
<td>

Enables the set_visible command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`siteview:deny-set-visible`

</td>
<td>

Denies the set_visible command without any pre-configured scope.

</td>
</tr>
</table>
