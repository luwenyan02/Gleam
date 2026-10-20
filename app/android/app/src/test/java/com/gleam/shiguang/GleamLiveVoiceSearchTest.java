package com.gleam.shiguang;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class GleamLiveVoiceSearchTest {
    private JSONObject response(Object count) throws Exception {
        return new JSONObject().put("status","completed").put("usage",new JSONObject().put("plugins",new JSONObject().put("search",new JSONObject().put("count",count))));
    }
    @Test public void actualUsageAndStructuredSourcesAreRequired() throws Exception {
        JSONObject value=response(1).put("search_info",new JSONObject("{\"search_results\":[{\"title\":\"天气\",\"url\":\"https://weather.invalid/\"},{\"url\":\"https://weather.invalid/\"},{\"url\":\"javascript:alert(1)\"},{\"url\":\"https://user:secret@unsafe.invalid/\"}]}"));
        JSONObject result=GleamLiveVoiceSearch.result(value);
        assertEquals("searched",result.getString("status"));assertEquals(1,result.getJSONArray("sources").length());
        assertEquals("https://weather.invalid/",result.getJSONArray("sources").getJSONObject(0).getString("url"));
    }
    @Test public void missingInvalidAndZeroUsageAreDistinctFromSuccess() throws Exception {
        for(Object count:new Object[]{JSONObject.NULL,"1",-1,1.5})assertEquals("unknown",GleamLiveVoiceSearch.result(response(count)).getString("status"));
        assertEquals("not-used",GleamLiveVoiceSearch.result(response(0)).getString("status"));
        assertEquals("failed",GleamLiveVoiceSearch.result(response(1).put("status","failed")).getString("status"));
        assertEquals(0,GleamLiveVoiceSearch.result(response(1).put("transcript","已经搜索 https://guessed.invalid/")).getJSONArray("sources").length());
    }
}
