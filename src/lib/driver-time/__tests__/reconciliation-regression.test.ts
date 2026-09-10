import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReconciledDrivers, formatMinutes, parseHoursMinutes, validateActual, reconciliationCsv, hubTimezone } from "../reconciliation";
import { detectWarehouseEvents } from "../detect";
import { usableCoordinates } from "../geo";
import { fetchHosLogs } from "../../samsara/hos.server";

const start = Date.parse("2026-08-17T12:00:00Z");
const wh = {id:"w",name:"Dallas",hub:"Dallas",circle:{latitude:32.8,longitude:-96.8,radiusMeters:100}};
const seg = (a:number,b:number,extra:any={}) => ({driverId:"d",vehicleId:"v",status:"onDuty",startMs:start+a*60000,endMs:start+b*60000,latitude:32.8,longitude:-96.8,...extra});
const detect = (segments:any[],options:any={},gpsSamples:any[]=[])=>detectWarehouseEvents({driver:{id:"d",name:"Test Driver"},segments,warehouses:[wh],options:{basis:"onduty" as const,tzOffsetMinutes:-300,...options},gpsSamples});
const event = (extra:any={})=>({driver_id:"d",driver_name:"Test Driver",event_date:"2026-08-17",duration_min:120,hub:"Dallas",location_source:"log",status:"new",needs_review:false,...extra});
const actual = (minutes=330)=>({driverName:"Test Driver",hub:"Dallas" as const,minutes,scope:"weekdays" as const,source:"Official report",reason:"Verified against supplied report"});

afterEach(()=>{vi.unstubAllEnvs();vi.stubGlobal("fetch",vi.fn(()=>{throw new Error("Network disabled");}));});
describe("official warehouse reporting",()=>{
  it("parses H:MM without decimal-hour ambiguity",()=>{expect(parseHoursMinutes("5:30")).toBe(330);expect(formatMinutes(330)).toBe("5:30");expect(()=>parseHoursMinutes("5.30")).toThrow();expect(()=>parseHoursMinutes("5:60")).toThrow();});
  it("keeps an official zero and drivers absent from events",()=>{const rows=buildReconciledDrivers([event()],[{driver_id:"d",warehouse_actual:actual(0),updated_at:"revision"}]);expect(rows[0].flaggedMinutes).toBe(0);expect(rows[0].automatedMinutes).toBe(120);expect(buildReconciledDrivers([],[{driver_id:"d",warehouse_actual:actual(0)}])).toHaveLength(1);});
  it("never adds official and automated weekday time together",()=>{const rows=buildReconciledDrivers([event()],[{driver_id:"d",warehouse_actual:actual()}]);expect(rows[0].flaggedMinutes).toBe(330);expect(rows[0].varianceMinutes).toBe(-210);expect(reconciliationCsv(rows)).toContain('"330","120","-210","330","5:30"');});
  it("excludes excused, superseded and unresolved rows while preserving evidence",()=>{const rows=buildReconciledDrivers([event({status:"excused"}),event({superseded_at:"2026-09-08"}),event({needs_review:true})],[]);expect(rows[0].events).toHaveLength(3);expect(rows[0].flaggedMinutes).toBe(0);expect(rows[0].unresolvedMinutes).toBe(120);});
  it("keeps weekend scope separate from weekday actuals",()=>{const es=[event(),event({event_date:"2026-08-22"})],os=[{driver_id:"d",warehouse_actual:actual()}];expect(buildReconciledDrivers(es,os)[0].flaggedMinutes).toBe(330);expect(buildReconciledDrivers(es,os,true)[0].flaggedMinutes).toBe(450);});
  it("rejects totals that disagree with source intervals",()=>{expect(()=>validateActual({...actual(),intervals:[{date:"2026-08-17",start:"2026-08-17T07:00:00-05:00",end:"2026-08-17T09:00:00-05:00",minutes:120}]},"2026-08-17")).toThrow(/add up/);});
  it("retains existing Paycom revision for optimistic concurrency",()=>{expect(buildReconciledDrivers([event()],[{driver_id:"d",updated_at:"rev",paycom_hours:40}])[0].revision).toBe("rev");});
  it("uses Eastern time only for Ocala",()=>{expect(hubTimezone("Ocala")).toBe("America/New_York");expect(hubTimezone("Birmingham")).toBe("America/Chicago");});
  it("joins only explicit report identities in the same warehouse",()=>{
    const report={driver_id:"report:dallas:test",warehouse_actual:actual()};
    expect(buildReconciledDrivers([event()],[report])).toHaveLength(1);
    expect(buildReconciledDrivers([event({hub:"Ocala"})],[report])).toHaveLength(2);
    expect(buildReconciledDrivers([event({driver_id:"different-person"})],[{driver_id:"d",warehouse_actual:actual()}])).toHaveLength(2);
  });
  it("rejects an official block extending into the weekend",()=>{
    expect(()=>validateActual({...actual(120),intervals:[{date:"2026-08-21",start:"2026-08-21T23:00:00-05:00",end:"2026-08-22T01:00:00-05:00",minutes:120}]},"2026-08-17")).toThrow(/weekdays/);
  });
});
describe("location and detection regressions",()=>{
  it("treats null island and nonfinite coordinates as missing",()=>{expect(usableCoordinates(0,0)).toBe(false);expect(usableCoordinates(NaN,1)).toBe(false);expect(usableCoordinates(91,1)).toBe(false);expect(usableCoordinates(0,10)).toBe(true);});
  it("recovers zero-coordinate blocks from the assigned vehicle GPS",()=>{const r=detect([seg(0,120,{latitude:0,longitude:0})],{},[{vehicleId:"v",timeMs:start,latitude:32.8,longitude:-96.8}]);expect(r[0].locationSource).toBe("vehicle_gps");expect(r[0].durationMin).toBe(120);});
  it("never borrows a different vehicle when driver vehicle is unknown",()=>{const r=detect([seg(0,120,{latitude:null,longitude:null,vehicleId:null})],{},[{vehicleId:"other",timeMs:start,latitude:32.8,longitude:-96.8}]);expect(r[0].needsReview).toBe(true);expect(r[0].addressId).toBeNull();});
  it("does not merge an off-duty gap",()=>{expect(detect([seg(0,60),seg(60,65,{status:"offDuty"}),seg(65,125)])).toHaveLength(0);});
  it("keeps short yard movement merging",()=>{expect(detect([seg(0,60),seg(60,65,{status:"driving"}),seg(65,125)])[0].durationMin).toBe(125);});
  it("uses strictly over 90 minutes before rounding",()=>{expect(detect([seg(0,90)])).toHaveLength(0);expect(detect([seg(0,89.8)])).toHaveLength(0);expect(detect([seg(0,91)])).toHaveLength(1);});
  it("does not rejoin across a non-midnight ELD boundary",()=>{const r=detect([seg(-300,-60)],{eldDayStartHour:4});expect(r).toHaveLength(2);expect(r.map(e=>e.durationMin)).toEqual([120,120]);});
});
describe("HOS transport normalization",()=>{
  it("joins driver pages, closes against next status and clips the query window",async()=>{
    vi.stubEnv("SAMSARA_API_TOKEN","test-only-token");
    const log=(minute:number,status:string)=>({logStartTime:new Date(start+minute*60000).toISOString(),hosStatusType:status,logRecordedLocation:{latitude:0,longitude:0},vehicle:{id:"v"}});
    let n=0;vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,status:200,json:async()=> ++n===1 ? {data:[{driver:{id:"d"},hosLogs:[log(-10,"onDuty")]}],pagination:{hasNextPage:true,endCursor:"next"}} : {data:[{driver:{id:"d"},hosLogs:[log(60,"driving")]}],pagination:{hasNextPage:false}}})));
    const result=await fetchHosLogs({startMs:start,endMs:start+120*60000,driverIds:["d"]});
    expect(result).toHaveLength(2);expect(result[0].startMs).toBe(start);expect(result[0].endMs).toBe(start+60*60000);expect(result[1].endMs).toBe(start+120*60000);expect(result[0].latitude).toBeNull();
  });
});
