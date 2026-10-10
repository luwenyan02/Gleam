package com.gleam.shiguang;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Fixed metadata only. Never construct diagnostics from provider strings or field values. */
enum GleamSpeechProtocolReason {
    ACK_SESSION_MISSING,
    ACK_SESSION_NULL,
    ACK_SESSION_TYPE,
    ACK_MODEL_TYPE,
    ACK_MODEL_MISMATCH,
    ACK_TURN_DETECTION_MISSING,
    ACK_TURN_DETECTION_TYPE,
    ACK_TURN_DETECTION_MISMATCH,
    ACK_MODALITIES_MISSING,
    ACK_MODALITIES_TYPE,
    ACK_MODALITIES_MISMATCH,
    ACK_TRANSCRIPTION_MISSING,
    ACK_TRANSCRIPTION_TYPE,
    ACK_TRANSCRIPTION_MODEL_MISSING,
    ACK_TRANSCRIPTION_MODEL_TYPE,
    ACK_TRANSCRIPTION_MODEL_MISMATCH,
    ACK_AUDIO_MISSING,
    ACK_AUDIO_TYPE,
    ACK_AUDIO_INPUT_MISSING,
    ACK_AUDIO_INPUT_TYPE,
    ACK_AUDIO_FORMAT_MISSING,
    ACK_AUDIO_FORMAT_TYPE,
    ACK_AUDIO_ENCODING_MISSING,
    ACK_AUDIO_ENCODING_TYPE,
    ACK_AUDIO_ENCODING_MISMATCH,
    ACK_SAMPLE_RATE_MISSING,
    ACK_SAMPLE_RATE_TYPE,
    ACK_SAMPLE_RATE_MISMATCH,
    ACK_SEARCH_TYPE,
    ACK_SEARCH_ENABLED,
    ACK_TOOLS_TYPE,
    ACK_TOOLS_NONEMPTY,
    ACK_CHANNELS_TYPE,
    ACK_CHANNELS_MISMATCH,
    ACK_SAMPLE_FORMAT_TYPE,
    ACK_SAMPLE_FORMAT_MISMATCH,
    ACK_PACKING_TYPE,
    ACK_PACKING_MISMATCH,
    ACK_CHANNEL_LAYOUT_TYPE,
    ACK_CHANNEL_LAYOUT_MISMATCH,
    ACK_UNSAFE_CONFIGURATION,
    FRAME_MALFORMED_JSON,
    FRAME_OVERSIZED,
    FRAME_BINARY,
    FRAME_PROCESSING_FAILED,
    COMMIT_ITEM_ID_INVALID,
    COMMIT_ITEM_ID_CONFLICT,
    TRANSCRIPT_ITEM_ID_CONFLICT,
    PROTOCOL_UNCLASSIFIED,
    ACK_SERVER_SESSION_ID_TYPE,
    ACK_SERVER_SESSION_ID_INVALID,
    ACK_SERVER_SESSION_ID_MISMATCH,
    ACK_UNEXPECTED_SESSION_EVENT,
    ACK_NESTED_TURN_DETECTION,
    UNEXPECTED_VAD_EVENT,
    UNEXPECTED_RESPONSE_EVENT;

    static final int MAX_REASONS = 24;
    static List<GleamSpeechProtocolReason> bounded(List<GleamSpeechProtocolReason> reasons) {
        List<GleamSpeechProtocolReason> safe = new ArrayList<>();
        if (reasons != null) {
            for (GleamSpeechProtocolReason reason : reasons) {
                if (reason != null && !safe.contains(reason)) safe.add(reason);
                if (safe.size() == MAX_REASONS) break;
            }
        }
        if (safe.isEmpty()) safe.add(PROTOCOL_UNCLASSIFIED);
        return Collections.unmodifiableList(safe);
    }
}
