package com.gleam.shiguang;

import java.io.IOException;
import okhttp3.*;

final class GleamUpdateHttp {
    static final class Failure extends IOException {
        final String code;
        Failure(String code) { this.code=code; }
    }
    interface Guard {
        void check() throws Exception;
        void track(Call call);
    }
    static Response get(OkHttpClient client, Guard guard, String initial, String token, boolean asset) throws Exception {
        if (!(initial.equals(GleamUpdateRelease.API+"/latest") || initial.matches(java.util.regex.Pattern.quote(GleamUpdateRelease.API)+"/assets/[1-9][0-9]*"))) throw new Failure("DOWNLOAD_SOURCE");
        String url=initial;
        for (int redirects=0;redirects<=3;redirects++) {
            guard.check();
            Request.Builder request=new Request.Builder().url(url).header("User-Agent", "Gleam-Android-Updater")
                .header("Accept", asset ? "application/octet-stream" : "application/vnd.github+json")
                .header("Cache-Control", "no-cache");
            if (redirects==0) request.header("Authorization", "Bearer "+token).header("X-GitHub-Api-Version", "2022-11-28");
            Call network=client.newCall(request.build()); guard.track(network);
            Response response=network.execute();
            int status=response.code();
            if (status==200 && response.body()!=null) return response;
            String location=response.header("Location"); response.close();
            if (asset && (status==301 || status==302 || status==303 || status==307 || status==308)) {
                if (location==null || !GleamUpdateRelease.allowedDownload(location)) throw new Failure("DOWNLOAD_SOURCE");
                url=location; continue;
            }
            if (status==401) throw new Failure("AUTH");
            if (status==403 || status==429) throw new Failure("FORBIDDEN");
            if (status==404) throw new Failure("NOT_FOUND");
            throw new Failure("NETWORK");
        }
        throw new Failure("DOWNLOAD_SOURCE");
    }
}
