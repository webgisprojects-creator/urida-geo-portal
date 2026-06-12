export const chainageCityConfig = {
    kanpur: {
        workspace: "Chainage",
        roadLayer: "Chainage:Kanpur_segmentszone2roads",
        chainageLayer: "Chainage:Kanpur_interpolatedpoints",
        roadIdField: "road_id",
        chainageField: "distance",
        chainageApi: "/api/chainage",
    },

    agra: {
        workspace: "Chainage",
        roadLayer: "Chainage:agra_seg1",
        chainageLayer: "Chainage:agra_points",
        roadIdField: "road_id",
        chainageField: "distance",
        chainageApi: "/api/chainage",
    },

    // jhansi: {
    //     roadLayer: "india:jhansi_roads",
    //     chainageLayer: "india:jhansi_chainage",
    //     roadIdField: "road_id",
    // },

    // 🔥 future cities just add here
};