import { fromLonLat } from "ol/proj";

export const cityConfig = {
  agra: {
    name: "Agra",
    center: fromLonLat([78.0081, 27.1767]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Agra_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Agra_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Agra_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Agra_Road_Network_Category" },
      condition: { layer: "Road_Network:Agra_Road_Network_Condition" },
      cus: { layer: "Road_Network:Agra_Road_Network_CUS" },
      material: { layer: "Road_Network:Agra_Road_Network_Material" },
      ownership: { layer: "Road_Network:Agra_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Agra_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Agra_Atm_Bank",
      bus_stop: "Amenities:Agra_Bus_Stop",
      graveyard: "Amenities:Agra_Graveyard",
      hospital: "Amenities:Agra_Hospital",
      hotel: "Amenities:Agra_Hotel",
      park: "Amenities:Agra_Park",
      petrol_pump: "Amenities:Agra_Petrol_Pump",
    },

    others: {
      central_gov: "Amenities:Agra_Central_Gov",
      community_toilet: "Amenities:Agra_Community_Toilet",
      education: "Amenities:Agra_Education",
      e_charging: "Amenities:Agra_Electric_Substation",
      landmark: "Amenities:Agra_Landmark",
      post_office: "Amenities:Agra_Post_Office",
      religious: "Amenities:Agra_Religious",
      state_gov: "Amenities:Agra_State_Gov",
    },
  },

  aligarh: {
    name: "Aligarh",
    center: fromLonLat([78.088, 27.8974]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Aligarh_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Aligarh_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Aligarh_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Aligarh_Road_Network_Category" },
      condition: { layer: "Road_Network:Aligarh_Road_Network_Condition" },
      cus: { layer: "Road_Network:Aligarh_Road_Network_CUS" },
      material: { layer: "Road_Network:Aligarh_Road_Network_Material" },
      ownership: { layer: "Road_Network:Aligarh_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Aligarh_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Aligarh_Atm_Bank",
      bus_stop: "Amenities:Aligarh_Bus_Stop",
      graveyard: "Amenities:Aligarh_Graveyard",
      hospital: "Amenities:Aligarh_Hospital",
      hotel: "Amenities:Aligarh_Hotel",
      park: "Amenities:Aligarh_Park",
      petrol_pump: "Amenities:Aligarh_Petrol_Pump",
    },

    others: {
      central_gov: "Amenities:Aligarh_Central_Gov",
      education: "Amenities:Aligarh_Education",
      landmark: "Amenities:Aligarh_Landmark",
      post_office: "Amenities:Aligarh_Post_Office",
      religious: "Amenities:Aligarh_Religious",
      state_gov: "Amenities:Aligarh_State_Gov",
    },
  },

  ayodhya: {
    name: "Ayodhya",
    center: fromLonLat([82.1944, 26.7999]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Ayodhya_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Ayodhya_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Ayodhya_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Ayodhya_Road_Network_Category" },
      condition: { layer: "Road_Network:Ayodhya_Road_Network_Condition" },
      cus: { layer: "Road_Network:Ayodhya_Road_Network_CUS" },
      material: { layer: "Road_Network:Ayodhya_Road_Network_Material" },
      ownership: { layer: "Road_Network:Ayodhya_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Ayodhya_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Ayodhya_Atm_Bank",
      bus_stop: "Amenities:Ayodhya_Bus_Stand",
      graveyard: "Amenities:Ayodhya_Graveyard",
      hospital: "Amenities:Ayodhya_Hospital",
      hotel: "Amenities:Ayodhya_Hotel",
      park: "Amenities:Ayodhya_Park",
      petrol_pump: "Amenities:Ayodhya_Petrol_Pump",
      stadium: "Amenities:Ayodhya_Stadium",
    },

    others: {
      car_charging: "Amenities:Ayodhya_Car_Charging",
      central_gov: "Amenities:Ayodhya_Central_Gov",
      community_toilet: "Amenities:Ayodhya_Public_Toilet",
      education: "Amenities:Ayodhya_Education",
      landmark: "Amenities:Ayodhya_Landmark",
      post_office: "Amenities:Ayodhya_Post_Office",
      religious: "Amenities:Ayodhya_Religious_Places",
    },

    specializedNetworks: {
      drainage: {
        label: "Drainage Network",
        options: {
          network: "Road_Network:Ayodhya_Drain",
          condition: "Road_Network:Ayodhya_Drain_Condition",
          material: "Road_Network:Ayodhya_Drain_Material",
          status: "Road_Network:Ayodhya_Drain_Status",
          type: "Road_Network:Ayodhya_Drain_Type",
        },
      },
      slum: {
        label: "Slum Data",
        options: {
          roads: "Road_Network:Ayodhya_Slum_Roads",
          boundary: "Road_Network:Ayodhya_Slum_Boundary",
        },
      },
    },
  },

  bareilly: {
    name: "Bareilly",
    center: fromLonLat([79.4304, 28.367]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Bareilly_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Bareilly_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Bareilly_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Bareilly_Road_Network_Category" },
      condition: { layer: "Road_Network:Bareilly_Road_Network_Condition" },
      cus: { layer: "Road_Network:Bareilly_Road_Network_CUS" },
      material: { layer: "Road_Network:Bareilly_Road_Network_Material" },
      ownership: { layer: "Road_Network:Bareilly_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Bareilly_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Bareilly_Atm_Bank",
      bus_stop: "Amenities:Bareilly_Bus_Stops",
      graveyard: "Amenities:Bareilly_Graveyard",
      hospital: "Amenities:Bareilly_Hospital",
      hotel: "Amenities:Bareilly_Hotel",
      park: "Amenities:Bareilly_Park",
      petrol_pump: "Amenities:Bareilly_Petrol_Pump",
      stadium: "Amenities:Bareilly_Stadium",
    },

    others: {
      central_gov: "Amenities:Bareilly_Central_Gov",
      education: "Amenities:Bareilly_Education",
      post_office: "Amenities:Bareilly_Post_Office",
      religious: "Amenities:Bareilly_Religious",
      state_gov: "Amenities:Bareilly_State_Gov",
    },
  },

  firozabad: {
    name: "Firozabad",
    center: fromLonLat([78.3949, 27.1591]),
    zoom: 11,

    // zoneLayer: "Ward_Boundary_New:Firozabad_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Firozabad_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Firozabad_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Firozabad_Road_Network_Category" },
      condition: { layer: "Road_Network:Firozabad_Road_Network_Condition" },
      cus: { layer: "Road_Network:Firozabad_Road_Network_CUS" },
      material: { layer: "Road_Network:Firozabad_Road_Network_Material" },
      ownership: { layer: "Road_Network:Firozabad_Road_Network_Ownership" },
      // ward: { layer: "Road_Network:Firozabad_Road_Network_Ward" },
      ward: { layer: "Road_Network:Firozabad_Road_Network" },
    },

    amenities: {
      atm_bank: "Amenities:Firozabad_Atm_Bank",
      bus_stop: "Amenities:Firozabad_Bus_Stop",
      graveyard: "Amenities:Firozabad_Graveyard",
      hospital: "Amenities:Firozabad_Hospital",
      hotel: "Amenities:Firozabad_Hotel",
      park: "Amenities:Firozabad_Park",
      petrol_pump: "Amenities:Firozabad_Petrol_Pump",
      stadium: "Amenities:Firozabad_Stadium",
    },

    others: {
      central_gov: "Amenities:Firozabad_Central_Gov",
      community_toilet: "Amenities:Firozabad_Community_Toilet",
      education: "Amenities:Firozabad_Education",
      landmark: "Amenities:Firozabad_Landmark",
      post_office: "Amenities:Firozabad_Post_Office",
      religious: "Amenities:Firozabad_Religious",
      state_gov: "Amenities:Firozabad_State_Gov",
    },
  },

  ghaziabad: {
    name: "Ghaziabad",
    center: fromLonLat([77.4538, 28.6692]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Ghaziabad_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Ghaziabad_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Ghaziabad_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Ghaziabad_Road_Network_Category" },
      condition: { layer: "Road_Network:Ghaziabad_Road_Network_Condition" },
      cus: { layer: "Road_Network:Ghaziabad_Road_Network_CUS" },
      material: { layer: "Road_Network:Ghaziabad_Road_Network_Material" },
      ownership: { layer: "Road_Network:Ghaziabad_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Ghaziabad_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Ghaziabad_Atm_Bank",
      bus_stop: "Amenities:Ghaziabad_Bus_Stop",
      graveyard: "Amenities:Ghaziabad_Graveyard",
      hospital: "Amenities:Ghaziabad_Hospital",
      hotel: "Amenities:Ghaziabad_Hotel",
      park: "Amenities:Ghaziabad_Park",
      petrol_pump: "Amenities:Ghaziabad_Petrol_Pump",
      // stadium: "Amenities:Firozabad_Stadium",
    },
    others: {
      central_gov: "Amenities:Ghaziabad_Central_Gov",
      // community_toilet: "Amenities:Firozabad_Community_Toilet",
      education: "Amenities:Ghaziabad_Education",
      // landmark: "Amenities:Firozabad_Landmark",
      post_office: "Amenities:Ghaziabad_Post_Office",
      religious: "Amenities:Ghaziabad_Religious",
      state_gov: "Amenities:Ghaziabad_State_Gov",
    },
  },

  gorakhpur: {
    name: "Gorakhpur",
    center: fromLonLat([83.3732, 26.7606]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Gorakhpur_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Gorakhpur_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Gorakhpur_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Gorakhpur_Road_Network_Category" },
      condition: { layer: "Road_Network:Gorakhpur_Road_Network_Condition" },
      cus: { layer: "Road_Network:Gorakhpur_Road_Network_CUS" },
      material: { layer: "Road_Network:Gorakhpur_Road_Network_Material" },
      ownership: { layer: "Road_Network:Gorakhpur_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Gorakhpur_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Gorakhpur_Atm_Bank",
      bus_stop: "Amenities:Gorakhpur_Bus_Stop",
      graveyard: "Amenities:Gorakhpur_Graveyard",
      hospital: "Amenities:Gorakhpur_Hospital",
      hotel: "Amenities:Gorakhpur_Hotel",
      park: "Amenities:Gorakhpur_Park",
      police_station: "Amenities:Gorakhpur_Police_Station",
      stadium: "Amenities:Gorakhpur_Stadium",
    },

    others: {
      cental_gov: "Amenities:Gorakhpur_Central_Gov",
      communication: "Amenities:Gorakhpur_Communication",
      community_toilet: "Amenities:Gorakhpur_Community_Toilet",
      e_charging: "Amenities:Gorakhpur_E-charging",
      education: "Amenities:Gorakhpur_Education",
      post_office: "Amenities:Gorakhpur_Post_Office",
      religious: "Amenities:Gorakhpur_Religious",
      state_gov: "Amenities:Gorakhpur_State_Gov",
    },
  },

  jhansi: {
    name: "Jhansi",
    center: fromLonLat([78.5685, 25.4484]),
    zoom: 11,

    // zoneLayer: "Ward_Boundary_New:jhansi_zone_boundary", // change layer
    wardLayer: "Ward_Boundary_New:Jhansi_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Jhansi_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Jhansi_Road_Network_Category" },
      condition: { layer: "Road_Network:Jhansi_Road_Network_Condition" },
      cus: { layer: "Road_Network:Jhansi_Road_Network_CUS" },
      material: { layer: "Road_Network:Jhansi_Road_Network_Material" },
      ownership: { layer: "Road_Network:Jhansi_Road_Network_Ownership" },
      ward: { layer: "Road_Network:Jhansi_Road_Network_Ward" },
    },

    amenities: {
      atm_bank: "Amenities:Jhansi_Atm_Bank",
      bus_stop: "Amenities:Jhansi_Bus_Stop",
      graveyard: "Amenities:Jhansi_Graveyard",
      hospital: "Amenities:Jhansi_Hospital",
      hotel: "Amenities:Jhansi_Hotel",
      park: "Amenities:Jhansi_Park",
      petrol_pump: "Amenities:Jhansi_Petrol_Pump",
      // police_station: "Amenities:Gorakhpur_Police_Station",
      stadium: "Amenities:Jhansi_Stadium",
    },

    others: {
      cental_gov: "Amenities:Jhansi_Central_Gov",
      // communication: "Amenities:Gorakhpur_Communication",
      // community_toilet: "Amenities:Gorakhpur_Community_Toilet",
      // e_charging: "Amenities:Gorakhpur_E-charging",
      education: "Amenities:Jhansi_Education",
      landmark: "Amenities:Jhansi_Landmark",
      post_office: "Amenities:Jhansi_Post_Office",
      religious: "Amenities:Jhansi_Religious",
      state_gov: "Amenities:Jhansi_State_Gov",
    },

    LCLUClassifications: {
      Jhansi_LCLU_ULU: "Amenities:Jhansi_LCLU_ULU",
    },
  },

  kanpur: {
    name: "Kanpur",
    center: fromLonLat([80.3319, 26.4499]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Kanpur_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Kanpur_Ward_Boundary", // change layer

    segmentLayer: "Chainage:Kanpur_segmentszone2roads",
    chainageLayer: "	Chainage:Kanpur_interpolatedpoints",

    roadLayer: "Road_Network:Kanpur_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Kanpur_Road_Network_Category" },
      condition: { layer: "Road_Network:Kanpur_Road_Network_Condition" },
      cus: { layer: "Road_Network:Kanpur_Road_Network_CUS" },
      material: { layer: "Road_Network:Kanpur_Road_Network_Material" },
      ownership: { layer: "Road_Network:Kanpur_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Kanpur_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Kanpur_Atm_Bank",
      bus_stop: "Amenities:Kanpur_Bus_Stop",
      graveyard: "Amenities:Kanpur_Graveyard",
      hospital: "Amenities:Kanpur_Hospital",
      hotel: "Amenities:Kanpur_Hotel",
      park: "Amenities:Kanpur_Park",
      stadium: "Amenities:Kanpur_Stadium",
    },

    others: {
      car_charging: "Amenities:Kanpur_Car_Charging",
      central_gov: "Amenities:Kanpur_Central_Gov",
      education: "Amenities:Kanpur_Education",
      post_office: "Amenities:Kanpur_Post_Office",
      religious: "Amenities:Kanpur_Religious",
      state_gov: "Amenities:Kanpur_State_Gov",
    },

    LCLUClassifications: {
      Kanpur_LCLU_Bridge_Culvert: "Amenities:Kanpur_LCLU_Bridge_Culvert",
      Kanpur_LCLU_Bus_Stop_Point: "Amenities:Kanpur_LCLU_Bus_Stop_Point",
      Kanpur_LCLU_Communication_Point:
        "Amenities:Kanpur_LCLU_Communication_Point",
      Kanpur_LCLU_Community_Toilet: "Amenities:Kanpur_LCLU_Community_Toilet",
      Kanpur_LCLU_Fire_Station: "Amenities:Kanpur_LCLU_Fire_Station",
      Kanpur_LCLU_ULU: "Amenities:Kanpur_LCLU_ULU",
    },
  },

  lucknow: {
    name: "Lucknow",
    center: fromLonLat([80.9462, 26.8467]),
    zoom: 11,

    // GeoServer WMS Layers
    zoneLayer: "Ward_Boundary_New:Lucknow_Zone_Boundary", // change layer name
    wardLayer: "Ward_Boundary_New:Lucknow_Ward_Boundary", // change layer name

    roadLayer: "Road_Network:Lucknow_Road_Network",

    sewageLayer_dia: "Road_Network:Lucknow_Sewage_Diameter_Net",
    sewageLayer_len: "Road_Network:Lucknow_Sewage_Length_Net",

    roadClassifications: {
      category: { layer: "Road_Network:Lucknow_Road_Network_Category" },
      condition: { layer: "Road_Network:Lucknow_Road_Network_Condition" },
      cus: { layer: "Road_Network:Lucknow_Road_Network_CUS" },
      material: { layer: "Road_Network:Lucknow_Road_Network_Material" },
      ownership: { layer: "Road_Network:Lucknow_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Lucknow_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Lucknow_Atm_Bank",
      bus_stop: "Amenities:Lucknow_Bus_Stop",
      graveyard: "Amenities:Lucknow_Graveyard",
      hospital: "Amenities:Lucknow_Hospital",
      hotel: "Amenities:Lucknow_Hotel",
      metro: "Amenities:Lucknow_Metro",
      park: "Amenities:Lucknow_Park",
      petrol_pump: "Amenities:Lucknow_Petrol_Pump",
      railway_station: "Amenities:Lucknow_Railway_Station",
      stadium: "Amenities:Lucknow_Stadium",
    },

    others: {
      cental_gov: "Amenities:Lucknow_Central_Gov",
      education: "Amenities:Lucknow_Education",
      landmark: "Amenities:Lucknow_Landmark",
      manhole: "Amenities:Lucknow_Manhole",
      post_office: "Amenities:Lucknow_Post_Office",
      religious: "Amenities:Lucknow_Religious",
      state_gov: "Amenities:Lucknow_State_Gov",
    },
  },

  mathura: {
    name: "Mathura",
    center: fromLonLat([77.6737, 27.4924]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Mathura_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Mathura_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Mathura_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Mathura_Road_Network_Category" },
      condition: { layer: "Road_Network:Mathura_Road_Network_Condition" },
      cus: { layer: "Road_Network:Mathura_Road_Network_CUS" },
      material: { layer: "Road_Network:Mathura_Road_Network_Material" },
      ownership: { layer: "Road_Network:Mathura_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Mathura_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Mathura_Atm_Bank",
      bus_stand: "Amenities:Mathura_Bus_Stand",
      graveyard: "Amenities:Mathura_Graveyard",
      hospital: "Amenities:Mathura_Hospital",
      hotel: "Amenities:Mathura_Hotel",
      park: "Amenities:Mathura_Park",
      petrol_pump: "Amenities:Mathura_Petrol_Pump",
    },

    others: {
      cental_gov: "Amenities:Mathura_Central_Gov",
      community_toilet: "Amenities:Mathura_Community_Toilet",
      education: "Amenities:Mathura_Education",
      landmark: "Amenities:Mathura_Landmark",
      post_office: "Amenities:Mathura_Post_Office",
      religious: "Amenities:Mathura_Religious_Place",
      state_gov: "Amenities:Mathura_State_Gov",
    },
  },
  meerut: {
    name: "Meerut",
    center: fromLonLat([77.7064, 28.9845]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Meerut_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Meerut_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Meerut_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Meerut_Road_Network_Category" },
      condition: { layer: "Road_Network:Meerut_Road_Network_Condition" },
      cus: { layer: "Road_Network:Meerut_Road_Network_CUS" },
      material: { layer: "Road_Network:Meerut_Road_Network_Material" },
      ownership: { layer: "Road_Network:Meerut_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Meerut_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Meerut_Atm_Bank",
      bus_stand: "Amenities:Meerut_Bus_Stop",
      graveyard: "Amenities:Meerut_Graveyard",
      hospital: "Amenities:Meerut_Hospital",
      hotel: "Amenities:Meerut_Hotel",
      park: "Amenities:Meerut_Park",
      petrol_pump: "Amenities:Meerut_Petrol_Pump",
      stadium: "Amenities:Meerut_Stadium",
    },

    others: {
      cental_gov: "Amenities:Meerut_Central_Gov",
      education: "Amenities:Meerut_Education",
      landmark: "Amenities:Meerut_Landmark",
      post_office: "Amenities:Meerut_Post_Office",
      religious: "Amenities:Meerut_Religious",
      state_gov: "Amenities:Meerut_State_Gov",
    },
  },

  moradabad: {
    name: "Moradabad",
    center: fromLonLat([78.7768, 28.8386]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Moradabad_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Moradabad_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Moradabad_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Moradabad_Road_Network_Category" },
      condition: { layer: "Road_Network:Moradabad_Road_Network_Condition" },
      cus: { layer: "Road_Network:Moradabad_Road_Network_CUS" },
      material: { layer: "Road_Network:Moradabad_Road_Network_Material" },
      ownership: { layer: "Road_Network:Moradabad_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Moradabad_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Moradabad_Atm_Bank",
      bus_stop: "Amenities:Moradabad_Bus_Stop",
      graveyard: "Amenities:Moradabad_Graveyard",
      hotel: "Amenities:Moradabad_Hotel",
      hospital: "Amenities:Moradabad_Hospital",
      park: "Amenities:Moradabad_Park",
      petrol_pump: "Amenities:Moradabad_Petrol_Pump",
      stadium: "Amenities:Moradabad_Stadium",
    },
    others: {
      centeral_gov: "Amenities:Moradabad_Centeral_Gov",
      education: "Amenities:Moradabad_Education",
      landmark: "Amenities:Moradabad_Land_Mark",
      post_office: "Amenities:Moradabad_Post_Office",
      religious: "Amenities:Moradabad_Religious_Place",
      state_gov: "Amenities:Moradabad_State_Gov",
    },
  },

  prayagraj: {
    name: "Prayagraj",
    center: fromLonLat([81.8463, 25.4358]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Prayagraj_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Prayagraj_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Prayagraj_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Prayagraj_Road_Network_Category" },
      condition: { layer: "Road_Network:Prayagraj_Road_Network_Condition" },
      cus: { layer: "Road_Network:Prayagraj_Road_Network_CUS" },
      material: { layer: "Road_Network:Prayagraj_Road_Network_Material" },
      ownership: { layer: "Road_Network:Prayagraj_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Prayagraj_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Prayagraj_Atm_Bank",
      bus_stop: "Amenities:Prayagraj_Bus_Stand",
      graveyard: "Amenities:Prayagraj_Graveyard",
      hospital: "Amenities:Prayagraj_Hospitals",
      hotel: "Amenities:Prayagraj_Hotels",
      // park: "Amenities:Prayagraj_Park",
      petrol_pump: "Amenities:Prayagraj_Petrol_Pump",
      stadium: "Amenities:Prayagraj_Stadium",
    },
    others: {
      centeral_gov: "Amenities:Prayagraj_Central_Gov",
      community_toilet: "Amenities:Prayagraj_Community_Toilet",
      education: "Amenities:Prayagraj_Education_Merge",
      e_charging: "Amenities:Prayagraj_Electric_Sub_Station",
      landmark: "Amenities:Prayagraj_Landmark",
      // mosque: "Amenities:Prayagraj_Mosque",
      post_office: "Amenities:Prayagraj_Post_Office",
      religious: "Amenities:Prayagraj_Religious",
      state_gov: "Amenities:Prayagraj_State_Gov",
      // temple:"Amenities:Prayagraj_Temple",
    },
  },

  saharanpur: {
    name: "Saharanpur",
    center: fromLonLat([77.546, 29.9679]),
    zoom: 11,

    // zoneLayer: "MRT_NN:meerut_zone_boundary", // change layer
    wardLayer: "Ward_Boundary_New:Saharanpur_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Saharanpur_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Saharanpur_Road_Network_Category" },
      condition: { layer: "Road_Network:Saharanpur_Road_Network_Condition" },
      cus: { layer: "Road_Network:Saharanpur_Road_Network_CUS" },
      material: { layer: "Road_Network:Saharanpur_Road_Network_Material" },
      ownership: { layer: "Road_Network:Saharanpur_Road_Network_Ownership" },
      ward: { layer: "Road_Network:Saharanpur_Road_Network_Ward" },
    },

    amenities: {
      atm_bank: "Amenities:Saharanpur_Atm_Bank",
      bus_stop: "Amenities:Saharanpur_Bus_Stop",
      graveyard: "Amenities:Saharanpur_Graveyard",
      hospital: "Amenities:Saharanpur_Hospital",
      hotel: "Amenities:Saharanpur_Hotel",
      park: "Amenities:Saharanpur_Park",
      petrol_pump: "Amenities:Saharanpur_Petrol_Pump",
      stadium: "Amenities:Saharanpur_Stadium",
    },
    others: {
      centeral_gov: "Amenities:Saharanpur_Central_Gov",
      community_toilet: "Amenities:Saharanpur_Community_Toilet",
      education: "Amenities:Saharanpur_Education",
      e_charging: "Amenities:Saharanpur_Electric_Substation",
      landmark: "Amenities:Saharanpur_Landmark",
      post_office: "Amenities:Saharanpur_Post_Office",
      religious: "Amenities:Saharanpur_Religious",
      state_gov: "Amenities:Saharanpur_State_Gov",
    },
  },

  shahjahanpur: {
    name: "Shahjahanpur",
    center: fromLonLat([79.912, 27.8804]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Shahjahanpur_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Shahjahanpur_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Shahjahanpur_Road_Network",

    roadClassifications: {
      category: { layer: "Road_Network:Shahjahanpur_Road_Network_Category" },
      condition: { layer: "Road_Network:Shahjahanpur_Road_Network_Condition" },
      cus: { layer: "Road_Network:Shahjahanpur_Road_Network_CUS" },
      material: { layer: "Road_Network:Shahjahanpur_Road_Network_Material" },
      ownership: { layer: "Road_Network:Shahjahanpur_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Shahjahanpur_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Shahjahanpur_Atm_Bank",
      bus_stop: "Amenities:Shahjahanpur_Bus_Stop",
      education: "Amenities:Shahjahanpur_Education",
      graveyard: "Amenities:Shahjahanpur_Graveyard",
      hospital: "Amenities:Shahjahanpur_Hospital",
      hotel: "Amenities:Shahjahanpur_Hotel",
      park: "Amenities:Shahjahanpur_Park",
      petrol_pump: "Amenities:Shahjahanpur_Petrol_Pump",
      // stadium: "Amenities:Saharanpur_Stadium",
    },
    others: {
      centeral_gov: "Amenities:Shahjahanpur_Central_Govt",
      // community_toilet: "Amenities:Saharanpur_Community_Toilet",
      // education: "Amenities:Saharanpur_Education",
      // e_charging: "Amenities:Saharanpur_Electric_Substation",
      landmark: "Amenities:Shahjahanpur_Landmark",
      post_office: "Amenities:Shahjahanpur_Post_Office",
      religious: "Amenities:Shahjahanpur_Religious",
      // state_gov: "Amenities:Saharanpur_State_Gov",
    },
  },
  varanasi: {
    name: "Varanasi",
    center: fromLonLat([82.9566, 25.3176]),
    zoom: 11,

    zoneLayer: "Ward_Boundary_New:Varanasi_Zone_Boundary", // change layer
    wardLayer: "Ward_Boundary_New:Varanasi_Ward_Boundary", // change layer

    roadLayer: "Road_Network:Varanasi_Road_Netwrok",

    roadClassifications: {
      category: { layer: "Road_Network:Varanasi_Road_Network_Category" },
      condition: { layer: "Road_Network:Varanasi_Road_Network_Condition" },
      cus: { layer: "Road_Network:Varanasi_Road_Network_CUS" },
      material: { layer: "Road_Network:Varanasi_Road_Network_Material" },
      ownership: { layer: "Road_Network:Varanasi_Road_Network_Ownership" },
      zone: { layer: "Road_Network:Varanasi_Road_Network_Zone" },
    },

    amenities: {
      atm_bank: "Amenities:Varanasi_Atm_Bank",
      bus_stop: "Amenities:Varanasi_Bus_Stop",
      graveyard: "Amenities:Varanasi_Graveyard",
      hospital: "Amenities:Varanasi_Hospital",
      hotel: "Amenities:Varanasi_Hotel",
      park: "Amenities:Varanasi_Park",
      petrol_pump: "Amenities:Varanasi_Petrol_Pump",
      stadium: "Amenities:Varanasi_Stadium",
    },
    others: {
      centeral_gov: "Amenities:Varanasi_Central_Gov",
      community_toilet: "Amenities:Varanasi_Community_Toilet",
      education: "Amenities:Varanasi_Education",
      e_charging: "Amenities:Varanasi_Electric_Substation",
      landmark: "Amenities:Varanasi_Landmark",
      post_office: "Amenities:Varanasi_Post_Office",
      religious: "Amenities:Varanasi_Religious",
      state_gov: "Amenities:Varanasi_State_Gov",
    },
  },
};
