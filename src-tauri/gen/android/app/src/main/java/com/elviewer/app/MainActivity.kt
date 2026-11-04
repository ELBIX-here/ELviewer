package com.elviewer.app

import android.app.Activity
import android.os.Build
import android.provider.Settings
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.gms.auth.GoogleAuthUtil
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import org.json.JSONObject

class MainActivity : TauriActivity() {
  /** Latest system-bar insets in CSS px, as JSON {"top":…,"right":…,"bottom":…,"left":…}. */
  @Volatile private var insetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"
  /** Set by the reader (window.ElKeys.setVolumePaging) while a book is open and the setting is on. */
  @Volatile private var volumePaging = false
  private var webView: WebView? = null
  private var lastVolumeTurn = 0L

  /** Google consent screen for Drive access; the request id waiting for its result. */
  private lateinit var consentLauncher: ActivityResultLauncher<IntentSenderRequest>
  private var pendingAuthId: String? = null

  private companion object {
    const val VOLUME_REPEAT_MS = 40L
    val DRIVE_SCOPES = listOf(
      Scope("https://www.googleapis.com/auth/drive.readonly"),
      Scope("https://www.googleapis.com/auth/drive.appdata"),
    )
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    consentLauncher = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { res ->
      val id = pendingAuthId ?: return@registerForActivityResult
      pendingAuthId = null
      if (res.resultCode != Activity.RESULT_OK) {
        deliverAuth(id, null, "cancelled")
        return@registerForActivityResult
      }
      try {
        val result = Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(res.data)
        deliverResult(id, result)
      } catch (e: ApiException) {
        deliverAuth(id, null, "api_${e.statusCode}")
      }
    }
  }

  /**
   * The app draws edge-to-edge (behind the status and navigation bars), but Android
   * WebView doesn't report those bars through CSS env(safe-area-inset-*). The page
   * reads them from `window.ElInsets.get()` and listens for `elinsets` events.
   */
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun setVolumePaging(on: Boolean) {
        volumePaging = on
      }
    }, "ElKeys")

    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun get(): String = insetsJson
    }, "ElInsets")

    // Shown to other devices as where a book was read: the name set in system settings
    // ("Galaxy S24"), else the model; tablets by their smallest screen width.
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun info(): String {
        val name = runCatching { Settings.Global.getString(contentResolver, "device_name") }.getOrNull()
          ?.takeIf { it.isNotBlank() } ?: Build.MODEL
        val tablet = resources.configuration.smallestScreenWidthDp >= 600
        return JSONObject().put("name", name).put("tablet", tablet).toString()
      }
    }, "ElDevice")

    // Google Drive access tokens (src/lib/gdrive.ts). The answer comes back as an
    // `elauth` event carrying {id, token} or {id, error}.
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun authorize(id: String, interactive: Boolean, stale: String) {
        Thread {
          // A token the API rejected must leave Play services' cache, or it is handed out again.
          if (stale.isNotEmpty()) runCatching { GoogleAuthUtil.clearToken(this@MainActivity, stale) }
          runOnUiThread { requestDriveAccess(id, interactive) }
        }.start()
      }
    }, "ElAuth")

    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val d = view.resources.displayMetrics.density
      insetsJson = "{\"top\":${bars.top / d},\"right\":${bars.right / d},\"bottom\":${bars.bottom / d},\"left\":${bars.left / d}}"
      view.post { (view as WebView).evaluateJavascript("window.dispatchEvent(new Event('elinsets'))", null) }
      insets
    }
    webView.post { ViewCompat.requestApplyInsets(webView) }
  }

  /** Google Identity Services authorization: no client secret, the app is recognised by package name + signing key. */
  private fun requestDriveAccess(id: String, interactive: Boolean) {
    val request = AuthorizationRequest.builder().setRequestedScopes(DRIVE_SCOPES).build()
    Identity.getAuthorizationClient(this)
      .authorize(request)
      .addOnSuccessListener { result ->
        val intent = result.pendingIntent
        if (result.hasResolution() && intent != null) {
          // Account picker / consent screen needed.
          if (!interactive) {
            deliverAuth(id, null, "consent_required")
          } else {
            pendingAuthId = id
            consentLauncher.launch(IntentSenderRequest.Builder(intent.intentSender).build())
          }
        } else {
          deliverResult(id, result)
        }
      }
      .addOnFailureListener { e ->
        deliverAuth(id, null, (e as? ApiException)?.let { "api_${it.statusCode}" } ?: (e.message ?: "error"))
      }
  }

  /** The consent screen lets people untick permissions; without Drive access the API just shows nothing. */
  private fun deliverResult(id: String, result: AuthorizationResult) {
    val granted = result.grantedScopes.toSet()
    when {
      result.accessToken == null -> deliverAuth(id, null, "no_token")
      !granted.containsAll(DRIVE_SCOPES.map { it.scopeUri }) -> deliverAuth(id, null, "scope_missing")
      else -> deliverAuth(id, result.accessToken, null)
    }
  }

  private fun deliverAuth(id: String, token: String?, error: String?) {
    val detail = JSONObject().put("id", id)
    if (token != null) detail.put("token", token)
    if (error != null) detail.put("error", error)
    webView?.post {
      webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('elauth', { detail: $detail }))", null)
    }
  }

  /** Volume keys turn pages (down = next) instead of changing the volume while reading. */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val code = event.keyCode
    if (volumePaging && (code == KeyEvent.KEYCODE_VOLUME_DOWN || code == KeyEvent.KEYCODE_VOLUME_UP)) {
      // Holding the key keeps turning pages (like Moon+ Reader), every key repeat (~20 pages a second) –
      // as fast as a held arrow key on the desktop. The reader skips the turn animation
      // while pages are flying by.
      val now = event.eventTime
      if (event.action == KeyEvent.ACTION_DOWN && (event.repeatCount == 0 || now - lastVolumeTurn >= VOLUME_REPEAT_MS)) {
        lastVolumeTurn = now
        val key = if (code == KeyEvent.KEYCODE_VOLUME_DOWN) "PageDown" else "PageUp"
        webView?.evaluateJavascript("window.dispatchEvent(new KeyboardEvent('keydown', { key: '$key' }))", null)
      }
      return true
    }
    return super.dispatchKeyEvent(event)
  }
}
