export const chainageCityConfig = {
    kanpur: {
        workspace: "Chainage",
        roadLayer: "Chainage:Kanpur_Chainage_Segments",
        chainageLayer: "Chainage:Kanpur_Chainage_Points",
        roadIdField: "road_id",
        chainageField: "distance",
        chainageApi: "/api/chainage",
    },

    agra: {
        workspace: "Road_Network",
        roadLayer: "Road_Network:agra_seg1",
        chainageLayer: "Road_Network:agra_points",
        roadIdField: "road_id",
        chainageField: "distance",
        chainageApi: "/api/chainage",
    },

    ghaziabad: {
        workspace: "Chainage",
        roadLayer: "Chainage:Ghaziabad_Chainage_Segment",
        chainageLayer: "Chainage:Ghaziabad_Chainage_Points",
        roadIdField: "road_id",
        chainageField: "distance",
        chainageApi: "/api/chainage",
    }
    // jhansi: {
    //     roadLayer: "india:jhansi_roads",
    //     chainageLayer: "india:jhansi_chainage",
    //     roadIdField: "road_id",
    // },

    // 🔥 future cities just add here
};