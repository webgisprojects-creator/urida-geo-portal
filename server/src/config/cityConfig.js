export const citySchemaMap = {
  agra: "agra",
  aligarh: "aligarh",
  ayodhya: "ayodhya",
  bareilly: "bareilly",
  firozabad: "firozabad",
  ghaziabad: "ghaziabad",
  gorakhpur: "gorakhpur",
  jhansi: "jhansi",
  kanpur: "kanpur",
  lucknow: "lucknow",
  mathura: "mathura",
  meerut: "meerut",
  moradabad: "moradabad",
  prayagraj: "prayagraj",
  saharanpur: "saharanpur",
  shahjahanpur: "shahjahanpur",
  varanasi: "varanasi",
};

export const getRoadTable = (city) => {
  const c = city.toLowerCase();
  const schema = citySchemaMap[c];
  if (!schema) throw new Error(`Invalid city schema for ${city}`);
  return `${schema}.${c}_road_net`;
};

export const getWardTable = (city) => {
  const c = city.toLowerCase();
  const schema = citySchemaMap[c];
  if (!schema) throw new Error(`Invalid city schema for ${city}`);
  return `${schema}.${c}_ward_boundary`;
};

export const getZoneTable = (city) => {
    const c = city.toLowerCase();
    const schema = citySchemaMap[c];
    if (!schema) throw new Error(`Invalid city schema for ${city}`);
    // Assuming zone table follows similar pattern
    if (c === 'lucknow') return 'lko_analysis.zone_development_summary_lnn'; // Based on old comments
    return `${schema}.${c}_zone_boundary`;
};
export const getAmenityTable = (city, amenityType) => {
  const c = city.toLowerCase();
  const schema = citySchemaMap[c];
  if (!schema) throw new Error(`Invalid city schema for ${city}`);

  const isCitySchema = schema !== 'public';

  const map = {
    bank: isCitySchema ? 'atm_bank' : `${c}_atm_bank`,
    atm_bank: isCitySchema ? 'atm_bank' : `${c}_atm_bank`,
    hospital: isCitySchema ? 'hospital' : `${c}_hospital`,
    education: isCitySchema ? 'education' : `${c}_education`,
    hotel: isCitySchema ? 'hotel' : `${c}_hotel`,
    park: isCitySchema ? 'park' : `${c}_park`,
  };
  const tbl = map[amenityType];
  if (!tbl) throw new Error(`Unsupported amenity type: ${amenityType}`);
  return `${schema}.${tbl}`;
};

export const getCityUtmEpsg = (city) => {
  const c = city.toLowerCase();
  const zoneMap = {
    ghaziabad: 32643,
    mathura: 32643,
    meerut: 32643,
    saharanpur: 32643,
    agra: 32644,
    aligarh: 32644,
    ayodhya: 32644,
    bareilly: 32644,
    firozabad: 32644,
    gorakhpur: 32644,
    jhansi: 32644,
    kanpur: 32644,
    lucknow: 32644,
    moradabad: 32644,
    prayagraj: 32644,
    shahjahanpur: 32644,
    varanasi: 32644,
  };
  const srid = zoneMap[c];
  if (!srid) throw new Error(`UTM SRID not mapped for ${city}`);
  return srid;
};
