package com.gleam.shiguang;

import java.net.URI;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/** Pure policy shared by release discovery, download and JVM regression tests. */
final class GleamUpdateRelease {
    static final String REPOSITORY = "luwenyan02/Gleam";
    static final String API = "https://api.github.com/repos/" + REPOSITORY + "/releases";
    static final long MAX_APK = 150L * 1024 * 1024;
    final long id, apkId, checksumId, size, code;
    final String version, name, notes;
    private GleamUpdateRelease(long id, long apkId, long checksumId, long size, long code, String version, String name, String notes) {
        this.id=id; this.apkId=apkId; this.checksumId=checksumId; this.size=size; this.code=code;
        this.version=version; this.name=name; this.notes=notes;
    }
    static long versionCode(String version) {
        if (version == null || !version.matches("v?(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]?)\\.(0|[1-9][0-9]?)")) throw new IllegalArgumentException("VERSION");
        String[] parts=version.replaceFirst("^v", "").split("\\.");
        long code=Long.parseLong(parts[0])*10000+Long.parseLong(parts[1])*100+Long.parseLong(parts[2]);
        if (code <= 0 || code > 2100000000) throw new IllegalArgumentException("VERSION");
        return code;
    }
    static GleamUpdateRelease parse(JSONObject json, long installedCode) throws Exception {
        if (json.getBoolean("draft") || json.getBoolean("prerelease")) return null;
        String tag=json.getString("tag_name"), version=tag.replaceFirst("^v", "");
        long code=versionCode(tag);
        if (code <= installedCode) return null;
        String name="Gleam-v"+version+".apk";
        long apk=0, checksum=0, size=0;
        JSONArray assets=json.getJSONArray("assets");
        for (int i=0;i<assets.length();i++) {
            JSONObject asset=assets.getJSONObject(i);
            if (!"uploaded".equals(asset.optString("state"))) continue;
            if (name.equals(asset.optString("name"))) {
                if (apk != 0) throw new IllegalArgumentException("ASSET");
                apk=asset.getLong("id"); size=asset.getLong("size");
            } else if ((name+".sha256").equals(asset.optString("name"))) {
                if (checksum != 0 || asset.getLong("size") > 1024) throw new IllegalArgumentException("ASSET");
                checksum=asset.getLong("id");
            }
        }
        long id=json.getLong("id");
        if (id<=0 || apk<=0 || checksum<=0 || size<=0 || size>MAX_APK) throw new IllegalArgumentException("ASSET");
        String notes=json.optString("body", "");
        return new GleamUpdateRelease(id, apk, checksum, size, code, version, name, notes.substring(0, Math.min(notes.length(), 6000)));
    }
    static String checksum(String text, String name) {
        String[] parts=text.trim().split("\\s+", 2);
        if (parts.length!=2 || !parts[0].matches("[a-fA-F0-9]{64}") || !(parts[1].equals(name) || parts[1].equals("*"+name))) throw new IllegalArgumentException("CHECKSUM");
        return parts[0].toLowerCase(Locale.ROOT);
    }
    static boolean allowedDownload(String url) {
        try {
            URI u=URI.create(url);
            return "https".equals(u.getScheme()) && u.getUserInfo()==null && u.getFragment()==null && (u.getPort()==-1 || u.getPort()==443)
                && ("release-assets.githubusercontent.com".equals(u.getHost()) || "objects.githubusercontent.com".equals(u.getHost()));
        } catch (IllegalArgumentException error) { return false; }
    }
}
