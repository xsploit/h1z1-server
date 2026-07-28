import unittest

from collision_classification import classify


class CollisionClassificationTests(unittest.TestCase):
    def test_walkable_surfaces(self):
        names = (
            "Common_Props_Sidewalks_Straight01.adr",
            "RoadIntersectionX.adr",
            "Common_Structures_Foundations_5x5m.adr",
            "Common_Props_WalkwaySlab02.adr",
            "Common_Props_Modular_Platform.adr",
            "Common_Structures_Bridges_BaileyBridgeRamp.adr",
            "Common_Structures_Houses_House24.adr",
            "Common_Structures_Warehouse01.adr",
            "Hospital_Structures_Floor1_Interior.adr",
        )
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(classify(name), 0)

    def test_solid_obstacles(self):
        names = (
            "Common_Props_RoadBarrier01.adr",
            "Common_Props_WreckedCar01.adr",
            "Common_Props_MilitaryBase_HescoBarrier.adr",
            "Common_Props_Boulder_Small_Boulder01.adr",
        )
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(classify(name), 1)

    def test_non_walkable_meshes(self):
        names = (
            "Common_Props_PaperScrap01.adr",
            "Common_Props_Bedroom_LampFloor03.adr",
            "Common_Structures_GasMartRoof01.adr",
            "Common_Props_Modular_StairRail.adr",
            "Common_Props_RoadMarkings_BrokenWhite.adr",
            "Common_Props_Sidewalks_ParkingLotBumper03_White.adr",
            "Common_Props_ChainLinkFence1x2.adr",
            "Common_Structures_ModularWall_Wall5m.adr",
            "ItemSpawnerResidential_Tier00.adr",
            "TotallyUnknownActor.adr",
        )
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(classify(name), 2)

    def test_doors_are_excluded_from_navigation(self):
        self.assertEqual(
            classify("Common_Structures_ModularWall_Door.adr"),
            3,
        )


if __name__ == "__main__":
    unittest.main()
