package com.gleam.shiguang;

import java.net.URI;
import java.util.LinkedHashSet;
import org.json.JSONArray;
import org.json.JSONObject;

/** Built-in search telemetry, never inferred from the spoken transcript. */
final class GleamLiveVoiceSearch {
    static JSONObject state(String status) throws Exception {
        return new JSONObject().put("status",status).put("sources",new JSONArray());
    }
    static JSONObject result(JSONObject response) throws Exception {
        if(response==null||!"completed".equals(response.opt("status")))return state("failed");
        JSONObject usage=response.optJSONObject("usage"),plugins=usage==null?null:usage.optJSONObject("plugins"),search=plugins==null?null:plugins.optJSONObject("search");
        Object raw=search==null?null:search.opt("count");
        if(!(raw instanceof Number))return state("unknown");
        double count=((Number)raw).doubleValue();
        if(Double.isNaN(count)||Double.isInfinite(count)||count<0||count>9007199254740991d||count!=Math.floor(count))return state("unknown");
        if(count==0)return state("not-used");
        JSONObject result=state("searched"),info=response.optJSONObject("search_info");
        JSONArray sources=result.getJSONArray("sources");LinkedHashSet<String> seen=new LinkedHashSet<>();
        append(sources,seen,info==null?null:info.optJSONArray("search_results"));
        append(sources,seen,response.optJSONArray("search_results"));
        return result;
    }
    private static void append(JSONArray target,LinkedHashSet<String> seen,JSONArray values) throws Exception {
        if(values==null)return;
        for(int i=0;i<Math.min(values.length(),120)&&target.length()<12;i++) {
            JSONObject source=values.optJSONObject(i);if(source==null||!(source.opt("url") instanceof String))continue;
            String url=source.getString("url");if(url.length()>2048||url.matches(".*[\\x00-\\x20].*"))continue;
            URI uri;
            try{uri=new URI(url);}catch(Exception ignored){continue;}
            if(!("http".equalsIgnoreCase(uri.getScheme())||"https".equalsIgnoreCase(uri.getScheme()))||uri.getHost()==null||uri.getUserInfo()!=null||!seen.add(url))continue;
            String title=source.opt("title") instanceof String?source.getString("title").trim():"";
            if(title.isEmpty())title=uri.getHost();if(title.length()>180)title=title.substring(0,180);
            target.put(new JSONObject().put("url",url).put("title",title));
        }
    }
    private GleamLiveVoiceSearch() {}
}
