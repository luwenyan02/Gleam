package com.gleam.shiguang;

import okhttp3.*;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;

public class GleamUpdateHttpTest {
    private final GleamUpdateHttp.Guard guard=new GleamUpdateHttp.Guard() {
        public void check() {}
        public void track(Call call) {}
    };
    private Response response(Request request,int status,String location) {
        Response.Builder result=new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("synthetic")
            .body(ResponseBody.create("content", MediaType.get("application/octet-stream")));
        if(location!=null) result.header("Location",location);
        return result.build();
    }
    @Test public void authenticatesOnlyTheFirstApiHop() throws Exception {
        List<Request> requests=new ArrayList<>();
        OkHttpClient client=new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).addInterceptor(chain->{
            Request request=chain.request(); requests.add(request);
            return requests.size()==1 ? response(request,302,"https://release-assets.githubusercontent.com/example") : response(request,200,null);
        }).build();
        try(Response ignored=GleamUpdateHttp.get(client,guard,GleamUpdateRelease.API+"/assets/21","synthetic_readonly_token",true)) {}
        assertEquals(2,requests.size());
        assertEquals("Bearer synthetic_readonly_token",requests.get(0).header("Authorization"));
        assertNull(requests.get(1).header("Authorization"));
    }
    @Test public void forbidsUntrustedRedirectsAndClassifiesAuthFailures() throws Exception {
        for(int status:new int[]{302,401,403,404,429,500}) {
            List<Request> requests=new ArrayList<>();
            OkHttpClient client=new OkHttpClient.Builder().followRedirects(false).addInterceptor(chain->{
                requests.add(chain.request()); return response(chain.request(),status,"https://evil.example/steal");
            }).build();
            try { GleamUpdateHttp.get(client,guard,GleamUpdateRelease.API+"/assets/21","synthetic_token",true); fail(); }
            catch(GleamUpdateHttp.Failure error) {
                assertEquals(status==302 ? "DOWNLOAD_SOURCE" : status==401 ? "AUTH" : status==404 ? "NOT_FOUND" : status==403 || status==429 ? "FORBIDDEN" : "NETWORK",error.code);
            }
            assertEquals(1,requests.size());
        }
    }
    @Test public void neverSendsTokenToAnArbitraryInitialUrl() throws Exception {
        OkHttpClient client=new OkHttpClient.Builder().addInterceptor(chain->{ fail("Network must not be called"); return null; }).build();
        try { GleamUpdateHttp.get(client,guard,"https://api.github.com/repos/other/repo/releases/latest","synthetic_token",false); fail(); }
        catch(GleamUpdateHttp.Failure error) { assertEquals("DOWNLOAD_SOURCE",error.code); }
    }
}
