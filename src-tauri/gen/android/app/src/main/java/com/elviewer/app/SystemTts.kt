package com.elviewer.app

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Read-aloud on Android through the phone's own text-to-speech engine (Samsung,
 * Google, …) – the desktop's neural model is too large for phones.
 *
 * Exposed to the page as `window.ElTts` (see src/lib/systemTts.ts). Calls are
 * fire-and-forget; progress comes back as `eltts` events on `window` with
 * `{type: "ready" | "error" | "start" | "done", id?, message?}`.
 */
class SystemTts(private val context: Context, private val webView: WebView) {
  private var tts: TextToSpeech? = null
  @Volatile private var ready = false
  private var initError: String? = null

  /** Starts the engine once; answers with a `ready` or `error` event. */
  @JavascriptInterface
  fun init() {
    if (ready) {
      emit(JSONObject().put("type", "ready"))
      return
    }
    if (tts != null) return // still starting
    webView.post {
      tts = TextToSpeech(context.applicationContext) { status ->
        if (status == TextToSpeech.SUCCESS) {
          val engine = tts!!
          engine.setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_MEDIA)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build(),
          )
          engine.setOnUtteranceProgressListener(listener)
          ready = true
          emit(JSONObject().put("type", "ready"))
        } else {
          initError = "init_failed"
          tts = null
          emit(JSONObject().put("type", "error").put("message", "init_failed"))
        }
      }
    }
  }

  /**
   * Engine state and its voices, Korean first:
   * {ready, engine, korean, voices: [{id, lang, network, quality}]}.
   */
  @JavascriptInterface
  fun status(): String {
    val engine = tts
    val out = JSONObject().put("ready", ready)
    if (initError != null) out.put("error", initError)
    if (!ready || engine == null) return out.put("voices", JSONArray()).toString()
    out.put("engine", engine.defaultEngine ?: "")
    val ko = Locale.KOREAN
    val korean = runCatching { engine.isLanguageAvailable(ko) >= TextToSpeech.LANG_AVAILABLE }.getOrDefault(false)
    out.put("korean", korean)
    val voices = runCatching { engine.voices?.toList() ?: emptyList() }.getOrDefault(emptyList())
      .filter { !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
      .sortedWith(compareBy({ it.locale.language != ko.language }, { it.isNetworkConnectionRequired }, { it.name }))
    val arr = JSONArray()
    for (v in voices) {
      arr.put(
        JSONObject()
          .put("id", v.name)
          .put("lang", v.locale.toLanguageTag())
          .put("network", v.isNetworkConnectionRequired)
          .put("quality", v.quality),
      )
    }
    return out.put("voices", arr).toString()
  }

  /**
   * Queues one sentence. `flush` drops anything still queued first. `voice` is a
   * voice id from status() or "" for the engine's Korean default. A silent gap of
   * `gapMs` follows the sentence. Speech rate/pitch 1.0 = normal; volume 0..1.
   */
  @JavascriptInterface
  fun speak(id: String, text: String, rate: Float, pitch: Float, voice: String, volume: Float, gapMs: Int, flush: Boolean) {
    val engine = tts ?: return
    if (!ready) return
    webView.post {
      val chosen = if (voice.isNotEmpty()) engine.voices?.firstOrNull { it.name == voice } else null
      if (chosen != null) {
        if (engine.voice?.name != chosen.name) engine.voice = chosen
      } else if (engine.voice?.locale?.language != Locale.KOREAN.language) {
        engine.language = Locale.KOREAN
      }
      engine.setSpeechRate(rate)
      engine.setPitch(pitch)
      val params = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume.coerceIn(0f, 1f)) }
      engine.speak(text, if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, params, id)
      if (gapMs > 0) engine.playSilentUtterance(gapMs.toLong(), TextToSpeech.QUEUE_ADD, "$id$GAP")
    }
  }

  /** Stops speaking and clears the queue. */
  @JavascriptInterface
  fun stop() {
    webView.post { tts?.stop() }
  }

  /** Opens the system text-to-speech settings (to install Korean voice data). */
  @JavascriptInterface
  fun openSettings() {
    val intent = Intent("com.android.settings.TTS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
  }

  fun shutdown() {
    tts?.stop()
    tts?.shutdown()
    tts = null
    ready = false
  }

  private val listener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String) {
      if (!utteranceId.endsWith(GAP)) emit(JSONObject().put("type", "start").put("id", utteranceId))
    }

    override fun onDone(utteranceId: String) {
      if (!utteranceId.endsWith(GAP)) emit(JSONObject().put("type", "done").put("id", utteranceId))
    }

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String) {
      onError(utteranceId, -1)
    }

    override fun onError(utteranceId: String, errorCode: Int) {
      if (!utteranceId.endsWith(GAP)) {
        emit(JSONObject().put("type", "error").put("id", utteranceId).put("message", "speak_failed_$errorCode"))
      }
    }
  }

  private fun emit(detail: JSONObject) {
    webView.post {
      webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('eltts', { detail: $detail }))", null)
    }
  }

  private companion object {
    const val GAP = "#gap"
  }
}
